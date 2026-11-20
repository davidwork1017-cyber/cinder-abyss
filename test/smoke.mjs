// 端到端冒烟测试：无头 Chrome 里把整个游戏流程走一遍。
// 每一步打印一行 ok / FAIL；任何一步失败或页面出现报错，进程以非 0 退出。
// 分两份（见 test/README.md）：main() 是 test:func（不看墙钟，可以和别的 Chrome 一起跑），timedMain() 是 test:timed（要独占机器）。
// node test/smoke.mjs = 两份都跑（先 func 后 timed）；--func / --timed 只跑一份。
import { launch as launchFull } from './harness.mjs';
import { execSync } from 'node:child_process';

const SAVE_KEY = 'cinder-abyss-save-v1';
let G_CUR_N = 8, G_UQ_COLOR = '#ff9b3d', G_SOUL_INH = 1.5, G_SOUL_K = 0.2;
const G_USK = { jinduan: 'ashcuts', sanxiang: 'tristorm', wanhun: 'soulhost', rongxin: 'wildfire', jinyu: 'emberstorm' }; // 烬铸武器 → 它的烬铸技 // 烬铸步骤用到的数据（启动后从页面里读）
let browser, page, errors;
let failed = 0;
let passed = 0;
// 省渲染（test/README.md「省渲染」）：test:func 默认让游戏按 devicePixelRatio 0.5 渲染（3D 画面和叠加层的像素只剩四分之一，
// CSS 布局和鼠标坐标不变），CINDER_FULL=1 关掉；test:timed 一直按原样。下面这些步骤要看像素 / 画面数值 / 指定尺寸下的布局，临时改回 1
const CHEAP_DPR = 0.5;
let cheap = false;
const FULL_RES = ['首屏：', '怪物：远处沉睡', '区域 ', '首领「', '画面：', '存档：刷新页面后', '技能卡版式：', '标题画面与暂停菜单在小窗口', '异兆小地图：', '宝箱：', '小地图：', '特效贴图库'];
const launch = (o) => launchFull(Object.assign({ dpr: cheap ? CHEAP_DPR : null }, o));
const setDpr = (d) =>
  page &&
  page
    .evaluate((d) => {
      try {
        sessionStorage.setItem('cinder-test-dpr', String(d));
      } catch (e) {}
      window.__testDpr = d;
      window.dispatchEvent(new Event('resize'));
    }, d)
    .catch(() => {});
let NC_TAG = ''; // 本次的耗时 / ms 数字不可比时（只跑 test:func，或在池里跑）挂在每行 ok 后面，见文件末尾

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
  const full = cheap && FULL_RES.some((p) => name.startsWith(p));
  if (full) await setDpr(1);
  try {
    const info = await fn();
    await sleep(30); // 给异步报错一点冒出来的时间
    if (errors && errors.length) throw new Error('页面报错：' + errors.splice(0).join(' | '));
    passed++;
    console.log('ok   ' + name + (info ? ' — ' + info : '') + '  (' + (Date.now() - t0) + 'ms)' + NC_TAG);
  } catch (e) {
    failed++;
    const extra = errors && errors.length ? ' ｜页面报错：' + errors.splice(0).join(' | ').slice(0, 600) : '';
    console.log('FAIL ' + name + ' — ' + String(e && e.message ? e.message : e).split('\n').slice(0, 6).join(' / ') + extra);
  }
  if (full) await setDpr(CHEAP_DPR);
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
      // 召唤物只在它的技能放在技能栏上时存在：直接调 G.summonMinion 的步骤先把用到的召唤技能放上栏（先占空格，没有空格再顶掉 Q / E / 左键上别的技能）。
      // 返回原来的技能栏，步骤结束时 G.save.bar = 返回值 还原（召唤步骤由 summonStep 还原）
      slotSummon(...ids) {
        const bar = G.save.bar, old = bar.slice(), K = [2, 3, 0];
        const free = K.filter((k) => !bar[k]).concat(K.filter((k) => bar[k] && !ids.includes(bar[k])));
        for (const id of ids) if (bar.indexOf(id) < 0) bar[free.shift()] = id;
        return old;
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
      // 技能栏四格里的技能 id（空格为 ''）。右键格显示的是武器普攻（basic_<武器类型>）
      hudBar() {
        return Array.from(document.querySelectorAll('#slots .slot')).map((n) => n.dataset.skill).join(',');
      },
      // 同上，但右键格的武器普攻记成 ''：和 save.bar（右键格一直是 null）对照用
      barHud() {
        return Array.from(document.querySelectorAll('#slots .slot')).map((n, i) => (i === 1 && /^basic_/.test(n.dataset.skill) ? '' : n.dataset.skill)).join(',');
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
      // 按住右键（武器普攻的连招；T.arena 换上的标准刃是「挥斩」），推进到下一次连击命中帧为止；返回这一段的信息
      swing(target, max) {
        const out = { step: -1, clip: null, ticks: 0, stop: 0, fired: false };
        let seen = null;
        for (let i = 0; i < (max || 150); i++) {
          if (target) T.aim(target.x, target.z);
          G.input.mouse.b[2] = true;
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
        G.input.mouse.b[2] = false;
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

// 拖之前把两端一起带进可视区（上一步可能把列表滚到了别处）。两端在同一个滚动容器里：都露着就不动，否则把两者的中点滚到容器中间；
// 不在同一个容器里：各自就近滚进来。技能列表上下各 40 像素是贴边自动滚动带（ui.js 的 EDGE_SCROLL），摆位置时尽量避开；
// 避不开也行（进带后要停 EDGE_DELAY 才滚，这里拖起、松手都在那之前）。然后核对每一端的中心：在视口里、在每一层裁剪它的容器里，
// elementFromPoint 打到的是它自己或它里面的节点。不满足就报错，不去拖
async function dragView(from, to) {
  const bad = await ev(([sels, edge]) => {
    const els = sels.map((s) => (s ? document.querySelector(s) : null));
    const lost = sels.filter((s, i) => s && !els[i]);
    if (lost.length) return '找不到 ' + lost.join('、');
    const clips = (n) => { const out = []; for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') out.push(p); } return out; };
    const scroller = (n) => clips(n).find((p) => /auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1) || null;
    // 技能列表的自动滚动带：已经滚到顶 / 底的那一边不会再滚，不用避
    const inset = (p, end) => (p.classList.contains('skill-list') && (end ? p.scrollTop < p.scrollHeight - p.clientHeight - 1 : p.scrollTop > 0) ? edge : 0);
    // 中心是否落在容器 p 的内容区里（不含滚动条）；band：再避开技能列表的自动滚动带
    const inside = (n, p, band) => { const b = n.getBoundingClientRect(), r = p.getBoundingClientRect(), y = b.top + b.height / 2, x = b.left + b.width / 2, top = r.top + p.clientTop, k0 = band ? inset(p, 0) : 0, k1 = band ? inset(p, 1) : 0; return x >= r.left + p.clientLeft && x <= r.left + p.clientLeft + p.clientWidth && y >= top + k0 && y <= top + p.clientHeight - k1; };
    const sc = els.map((n) => (n ? scroller(n) : null));
    if (els[0] && els[1] && sc[0] && sc[0] === sc[1]) {
      const p = sc[0];
      if (!els.every((n) => inside(n, p, true))) {
        const box = p.getBoundingClientRect();
        const ys = els.map((n) => { const b = n.getBoundingClientRect(); return b.top + b.height / 2; });
        p.scrollTop += (ys[0] + ys[1]) / 2 - (box.top + p.clientTop + p.clientHeight / 2);
      }
    } else {
      els.forEach((n, i) => {
        if (!n) return;
        n.scrollIntoView({ block: 'nearest' });
        if (sc[i] && !inside(n, sc[i], true)) n.scrollIntoView({ block: 'center' });
      });
    }
    const errs = [];
    els.forEach((n, i) => {
      if (!n) return;
      const b = n.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
      const where = (i ? '终点 ' : '起点 ') + sels[i] + ' 的中心 (' + Math.round(x) + ',' + Math.round(y) + ')';
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) errs.push(where + ' 在视口外（' + innerWidth + '×' + innerHeight + '）');
      for (const p of clips(n)) {
        if (inside(n, p)) continue;
        const r = p.getBoundingClientRect();
        errs.push(where + ' 不在容器 .' + String(p.className).trim().split(/\s+/).join('.') + ' 的可见区里（' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + '，scrollTop ' + Math.round(p.scrollTop) + '）');
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === n || n.contains(hit))) errs.push(where + ' 被挡住：elementFromPoint 打到 ' + (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + '.' + String(hit.className).trim().split(/\s+/).join('.') : 'null'));
    });
    return errs.join('；');
  }, [[from, to].map((s) => (typeof s === 'string' ? s : null)), 40]);
  assert(!bad, '拖拽两端没法同时露在视野里：' + bad);
}

// 用真鼠标把 from 拖到 to（选择器或坐标）；mid 在松手前执行
async function dragTo(from, to, mid) {
  if (typeof from === 'string' || typeof to === 'string') await dragView(from, to);
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

// 面板打开时有 0.16 秒的入场动画（缩放 0.99 → 1），getBoundingClientRect 量到的宽高跟着变；机器忙时这段动画会拖到一两秒。
// 量技能卡尺寸之前：等面板上没有在播的动画，再连续两帧量所有技能卡的位置和大小，一样才算排好
async function panelSettled() {
  for (let i = 0; i < 300; i++) {
    const ok = await ev(() => new Promise((res) => {
      const win = document.getElementById('panel-win');
      if (!win || win.getAnimations().some((a) => a.playState === 'running' || a.playState === 'pending')) return requestAnimationFrame(() => res(false));
      const m = () => Array.from(document.querySelectorAll('#panel .skill-card')).map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].join(','); }).join('|');
      const a = m();
      requestAnimationFrame(() => requestAnimationFrame(() => res(a === m())));
    }));
    if (ok) return;
  }
  throw new Error('技能页一直没排好（入场动画没播完或卡片尺寸一直在变）');
}

// 确认面板里的文字没有漏出 undefined / NaN
function cleanText(txt, where) {
  assert(txt.length > 40, where + ' 内容太少：' + JSON.stringify(txt.slice(0, 60)));
  assert(!/undefined|NaN|\[object|\{[a-z]\}/.test(txt), where + ' 里出现了未格式化的文本：' + (txt.match(/.{0,20}(undefined|NaN|\[object|\{[a-z]\}).{0,20}/) || [''])[0]);
}

// 裂石击已删除（近战的连招在右键的武器普攻上，见「武器普攻」那几步）
const SKILL_IDS = ['ember', 'blade', 'nova', 'arc', 'meteor', 'blink', 'whirl', 'shadestep', 'thrall', 'colossus'];
const BAR_SLOTS = [0, 2, 3]; // 能绑技能的三格（右键固定是武器普攻）
const INPUT_NAME = ['左键', '右键', 'Q', 'E'];
async function holdInput(slot, down) {
  if (slot === 0) await page.mouse[down ? 'down' : 'up']({ button: 'left' });
  else if (slot === 1) await page.mouse[down ? 'down' : 'up']({ button: 'right' });
  else await page.keyboard[down ? 'down' : 'up'](slot === 2 ? 'KeyQ' : 'KeyE');
}

// ------------------------------------------------------------------ test:timed（计时步骤）
// 这些断言看的是墙钟时间：空闲回调里的图标预热、按 performance.now 计时的 R 格气泡 / 新手提示 / 大字提示、单次耗时上限。
// 机器一忙就会误报，所以单独成一份：npm run test:timed，要独占机器（cc-slot run <名字> test -- npm run test:timed）。
// main()（test:func）里对应的步骤只留功能部分。每条计时断言从原步骤原样搬来（条件和上限一个字不改），前面补上它要的最少准备。
// 新加的计时断言写进这里、不写进 main()：步骤名用「计时｜」开头，并在 test/README.md 的表里记一行。
async function timedMain() {
  // 准备：和 main() 开头「启动」「首屏」两步同样的操作（不含断言），图标预热的起点和原来一样
  ({ browser, page, errors } = await launch({ width: 1440, height: 900 }));
  await install();
  await ev(() => G.debug.hold(false));
  await frames(3);
  await ev(() => G.state.time);
  await frames(2);
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyH');
  await ev(() => T.bodyText());
  await closePanel();
  await sleep(30);
  await frames(2);
  await ev(() => T.frame());
  await sleep(30);

  // 原步骤：main() 里的「图标预热」（那边只等它画完，不计时）
  await step('计时｜图标预热：启动后趁空闲分批画好全部图标（120 秒内），第一次打开背包不用现画', async () => {
    const t0 = Date.now();
    // 只是功能检查的超时：SwiftShader 在单核较慢的机器上安静时也要 60 秒上下才画完，留出一倍余量
    await until(() => G.icons.ready(), null, 120000).catch(() => {
      throw new Error('启动后图标没有在空闲时预先画好');
    });
    const n = await ev(() => G.icons.keys().length);
    assert(n >= 60, '图标数量不对：' + n);
    return n + ' 个图标，启动后 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒内就绪';
  });

  // 原步骤：main() 里的「武器界面：HUD 的 R 格……」。气泡的 deny 样式按 performance.now 留 620 ms，等两三帧后还得在：帧一慢就没了
  await uiStep('计时｜武器界面：空手按 R 时 R 格抖一下、冒出「没有武器」（气泡留 620 ms，两三帧后还在）', async () => {
    const r = await ev(async () => {
      const wait = (n) => new Promise((res) => { let i = 0; const f = () => (++i > n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const keep = G.save.equip.weapon;
      const ws = () => document.getElementById('wslot');
      const out = {};
      try {
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
      } finally {
        G.save.equip.weapon = keep;
        G.input.keys.KeyR = false;
        G.player.cds = {};
        G.computeStats();
      }
      return out;
    });
    assert(r.none.empty && r.none.txt === '无武器' && r.none.deny === '没有武器', '空手时 R 格应写「无武器」，按 R 时说明：' + JSON.stringify(r.none));
    return '气泡：' + r.none.deny;
  });

  // 原步骤：main() 里的「新手提示：……」。提示按真实时间走（coach 用 performance.now）
  const hint = () => ev(() => Object.assign(G.ui.hints(), { cls: document.getElementById('coach').className, txt: document.getElementById('coach').innerText, tut: Object.keys(G.save.tut).join() }));
  const shown = (id) => until((id) => G.ui.hints().current === id && G.ui.hints().state === 'show' && document.getElementById('coach').classList.contains('on'), id).catch(() => {
    throw new Error('提示「' + id + '」没有出现');
  });
  const seen = (id) => until((id) => !!G.save.tut[id], id).catch(() => {
    throw new Error('提示「' + id + '」没有在做到之后标记为看过');
  });
  const hintsEnd = () =>
    ev(() => {
      G.debug.hold(true);
      G.clearEnemies();
      G.player.roll.cd = 0;
      T.hintsSeen();
      G.save.level = 1;
      G.computeStats();
      G.player.life = G.player.maxLife;
      G.player.mana = G.player.maxMana;
      G.persist();
    });
  await uiStep('计时｜新手提示：做到之后「做到了」不会一闪而过（按下翻滚 1.9 秒后才换掉）', async () => {
    // 和原步骤走到这里时一样：本次从 1 级玩上来的角色升到 3 级，基础提示只差翻滚，身边一只不动的敌人
    await ev(() => {
      T.arena();
      G.save.bag.length = 0;
      G.save.blankGems = [];
      G.save.tut = { move: 1, attack: 1, bag: 1, craft: 1, support: 1, passive: 1, combo: 1, poise: 1, wskill: 1 };
      G.save.level = 3;
      G.computeStats();
      G.ui.refresh();
      G.debug.hold(false);
      T.mob('husk', 9, 0, { speed: 0, atkCd: 1e9 });
    });
    await page.mouse.move(900, 450);
    await shown('dodge');
    const t0 = Date.now();
    await page.keyboard.press('Space');
    await seen('dodge');
    await hint(); // 原步骤在这里读一次提示状态（「做到了」的断言在 test:func 里），往返照样做一次
    await until(() => G.ui.hints().current !== 'dodge');
    assert(Date.now() - t0 >= 1900, '提示在做到之后消失得太快：' + (Date.now() - t0) + ' ms');
    const ms = Date.now() - t0;
    await hintsEnd();
    return ms + ' ms 后换掉';
  });
  await uiStep('计时｜新手提示：濒死时喝药的提示 5 秒内顶掉正在显示的面板提示（天赋）', async () => {
    // 和原步骤走到这里时一样：5 级、有天赋点，天赋提示正亮着
    await ev(() => {
      T.arena();
      G.save.bag.length = 0;
      G.save.blankGems = [];
      G.save.level = 5;
      G.computeStats();
      G.save.tut = { move: 1, attack: 1, dodge: 1, combo: 1, poise: 1, loot: 1, bag: 1, craft: 1, support: 1, execute: 1, boss: 1, portal: 1, wskill: 1 };
      G.resetPassives();
      G.player.flask.life = 3;
      G.ui.refresh();
      G.debug.hold(false);
    });
    await page.mouse.move(900, 450);
    await shown('passive');
    await ev(() => { G.player.life = G.player.maxLife * 0.2; });
    const tf = Date.now();
    await shown('flask');
    const r = await hint();
    assert(Date.now() - tf < 5000 && !r.tut.includes('passive') && r.txt.includes('生命药剂'), '濒死时喝药的提示应立刻顶掉正在显示的面板提示：' + JSON.stringify(r));
    const ms = Date.now() - tf;
    await hintsEnd();
    return ms + ' ms 顶上来';
  });

  // 原步骤：main() 里的「大字提示不互相顶掉……」。大字按 performance.now 放 4.3 秒，3 秒时还得在、5.2 秒时得没了
  await step('计时｜大字提示：排在下面的放满自己的时间（3 秒时还在），放完之后全部消失', async () => {
    const vis = () =>
      ev(() => {
        const bt = document.getElementById('big-toast'), st = document.getElementById('big-toast-stack');
        const seen = (el) => !!el && getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().height > 0;
        return { main: bt ? bt.innerText.replace(/\s+/g, ' ') : '', mainOn: !!bt && bt.classList.contains('on') && seen(bt), stack: st ? st.innerText.replace(/\s+/g, ' ') : '', stackOn: seen(st), rows: st ? st.querySelectorAll('.bts-row').length : 0 };
      });
    await ev(() => {
      G.ui.bigToastReset();
      G.ui.bigToast(G.RELIC_NAME, '甲之渊契', G.RELIC_COLOR, '机制甲');
      G.ui.bigToast('烬铸武器', '乙之烬铸', G.RARITY_COLOR[3], '机制乙');
    });
    await vis(); // 原步骤在这两处各读一次（「两条」「5 条」的断言在 test:func 里），往返照样做
    await ev(() => {
      for (let i = 1; i <= 3; i++) G.ui.bigToast('烬铸武器', '丙之' + i, G.RARITY_COLOR[3], '');
    });
    await vis();
    await sleep(3000);
    const later = await vis();
    await sleep(2200);
    const gone = await vis();
    assert(later.stackOn && later.rows >= 1, '排在下面的应放满自己的时间（3 秒时还在）：' + JSON.stringify(later));
    assert(!gone.stackOn && !gone.mainOn, '放完之后应全部消失：' + JSON.stringify(gone));
    return '3 秒时下面还有 ' + later.rows + ' 行';
  });

  // 原步骤：main() 里的「渊印·生成……」。下面这段循环和那一步的逐字相同（计的就是这段活的单次耗时，少做一点都等于放宽）；改那一步的循环时这里跟着改
  await step('计时｜渊印·生成：掷一次三枚印（连同校验）平均不到 2 ms', async () => {
    const r = await ev(() => {
      const out = { bad: [], W: {}, n: {}, maxDz: {} };
      const bars = [['cleave', 'ember', null, null], ['vortex', 'nova', 'blackhole', 'thrall']];
      const t0 = performance.now();
      let rolls = 0;
      for (const tier of [1, 2, 3]) {
        const T = G.sealTierDef(tier);
        out.maxDz[tier] = 0;
        for (let seq = 0; seq < 1000; seq++) {
          const zi = seq % 5, bar = bars[seq % 2];
          const seals = G.rollSeals(zi, tier, seq, bar);
          rolls++;
          if (seals.length !== 3 || seals.some((s, g) => s.g !== g)) out.bad.push('三枚印不全 ' + tier + '/' + seq);
          if (JSON.stringify(G.rollSeals(zi, tier, seq, bar)) !== JSON.stringify(seals)) out.bad.push('同种子结果不同 ' + seq);
          for (const s of seals) {
            const ids = s.mods.map((m) => m.id), n = ids.length;
            const nMin = Math.max(T.n[0], s.g === 2 ? T.minN3 : 0), nMax = T.n[1] + (s.g === 2 ? 1 : 0);
            const W = G.sealW(s, bar), dz = G.sealDanger(s), rage = ids.filter((id) => G.SEAL_MODS[id].rage).length;
            const dead = s.mods.filter((m) => G.sealModW(m, bar) === 0).length;
            const tint = s.mods.filter((m) => m.id === 'tint');
            out.maxDz[tier] = Math.max(out.maxDz[tier], dz);
            const key = tier + ':' + s.g;
            out.W[key] = out.W[key] || {};
            out.W[key][W] = (out.W[key][W] || 0) + 1;
            if (n < nMin || n > nMax) out.bad.push('条数 ' + key + ' ' + n);
            if (W !== s.W || W < T.W[s.g][0] || W > T.W[s.g][1]) out.bad.push('W ' + key + ' ' + W);
            if (dz > T.budget + 1e-9) out.bad.push('预算 ' + key + ' ' + dz);
            if (rage > 2 || dead > 1 || new Set(ids).size !== n || tint.length > 1) out.bad.push('互斥 ' + ids.join());
            if (tint.length && (tint[0].el === G.ZONES[zi].elem || !G.SEAL_TINT[tint[0].el])) out.bad.push('焚染元素 ' + tint[0].el);
          }
        }
      }
      out.ms = +((performance.now() - t0) / rolls).toFixed(3);
      return out;
    });
    assert(r.ms < 2, '掷一次三枚印太慢：' + r.ms + ' ms');
    return '每次 ' + r.ms + ' ms';
  });

  // 原步骤：main() 里的「异兆选址」。S.zone.ms.enc 是 enterZone 里按 performance.now 量的选址耗时；下面照原步骤的种子把 100 个布局各进一次
  await step('计时｜异兆选址：100 个布局正常进区时，选址最慢一次不到 5 ms', async () => {
    const r = await ev(() => {
      const S = G.state;
      let msMax = 0;
      for (let z = 0; z < 5; z++) {
        for (let s = 1; s <= 20; s++) {
          G.debug.zoneSeed(3000 + z * 101 + s * 7);
          G.enterZone(z, 1);
          msMax = Math.max(msMax, S.zone.ms.enc); // 正常进区（掷 1–2 个）的选址耗时
        }
      }
      G.debug.zoneSeed(null);
      G.enterZone(0, 0);
      return { msMax: +msMax.toFixed(2) };
    });
    assert(r.msMax < 5, '选址耗时太长（设计 < 1 ms）：' + r.msMax);
    return '选址最慢 ' + r.msMax + ' ms';
  });

  // 原步骤：整步从 main() 搬来（ui-batch 的「技能页拖拽贴边自动滚动」，断言一字不改）。贴边自动滚动按 performance.now 走：进边带停 250 ms 才滚、
  // 最快每秒 900 像素，拖起 / 松手要在这段停顿之内做完。前面补上它要的构筑：学会全部技能和辅助宝石（main() 里走到这一步时前面的步骤已经学过）
  await ev(() => {
    G.debug.learnAll();
    G.computeStats();
  });
  await uiStep('计时｜技能页拖拽贴边自动滚动：拖着宝石时滚轮照常能滚；指针离列表下边 40 像素以外不滚，贴到下边就往下滚；滚到开拖时看不见的远处孔上松手能镶上', async () => {
    await ev(() => {
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.socketSupport('ember', 0, 'multi');
      G.computeStats();
    });
    await page.keyboard.press('KeyG');
    await panelSettled();
    const src = '.skill-list .sock[data-skill="ember"][data-idx="0"]';
    // 把起点的孔滚到列表顶下 80 像素（单列时掷焰卡排在武器普攻卡下面，滚到顶它不在视野里）；
    // 远处的孔 = 列表里能镶多重投射、离顶最远的那个孔（武器普攻卡除外）
    const g = await ev((src) => {
      const L = document.querySelector('.skill-list');
      L.scrollTop += T.rect(src).y - (L.getBoundingClientRect().top + L.clientTop + 80);
      const lr = L.getBoundingClientRect();
      const far = Array.from(L.querySelectorAll('.sock')).filter((n) => n.dataset.skill !== G.BASIC_CARD && n.dataset.skill !== 'ember' && G.supportFits(n.dataset.skill, 'multi')).sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
      return { far: far ? '.skill-list .sock[data-skill="' + far.dataset.skill + '"][data-idx="' + far.dataset.idx + '"]' : null, skill: far && far.dataset.skill, idx: far && +far.dataset.idx, farY: far && T.rect(far).y, a: T.rect(src), top: lr.top, bottom: lr.top + L.clientHeight, x: lr.left + L.clientWidth / 2, s0: L.scrollTop, max: L.scrollHeight - L.clientHeight };
    }, src);
    assert(g.far && g.farY > g.bottom && g.s0 < g.max, '远处的孔开拖时应在列表可见区下面：' + JSON.stringify(g));
    assert(g.a.y > g.top + 40 && g.a.y < g.bottom - 40, '起点的孔应在列表上部、贴边带以外：' + JSON.stringify(g));
    const top = () => ev(() => document.querySelector('.skill-list').scrollTop);
    await page.mouse.move(g.a.x, g.a.y);
    await page.mouse.down();
    await page.mouse.move(g.a.x + 9, g.a.y + 6, { steps: 2 });
    assert(await ev(() => document.getElementById('drag-ghost').classList.contains('on')), '没有拖起来');
    // 拖着的时候滚轮照常能滚
    await page.mouse.wheel(0, 120);
    await until((s0) => document.querySelector('.skill-list').scrollTop > s0, g.s0).catch(() => {
      throw new Error('拖拽中滚轮滚不动技能列表');
    });
    // 离下边 60 像素（贴边带外）：等滚轮的平滑滚动停下，再停 10 帧，不滚
    await page.mouse.move(g.x, g.bottom - 60, { steps: 3 });
    let s1 = await top();
    for (let i = 0; i < 60; i++) {
      await frames(3);
      const s = await top();
      if (s === s1) break;
      s1 = s;
    }
    await frames(10);
    const s2 = await top();
    assert(s2 === s1, '指针在贴边带以外时列表不应自己滚：' + s1 + ' → ' + s2);
    // 贴到下边：往下滚，直到远处的孔进了可见区、离开贴边带（或者滚到了底）
    await page.mouse.move(g.x, g.bottom - 6, { steps: 2 });
    await until((s2) => document.querySelector('.skill-list').scrollTop > s2 + 40, s2).catch(async () => {
      throw new Error('指针贴到列表下边没有自动往下滚：scrollTop ' + s2 + ' → ' + (await top()));
    });
    await until(([far, edge]) => {
      const L = document.querySelector('.skill-list'), r = L.getBoundingClientRect(), y = T.rect(far).y;
      return L.scrollTop >= L.scrollHeight - L.clientHeight - 1 || (y > r.top + edge && y < r.top + L.clientHeight - edge - 60);
    }, [g.far, 40]).catch(async () => {
      const d = await ev((far) => new Promise((res) => { const L = document.querySelector('.skill-list'), r = L.getBoundingClientRect(), g = document.getElementById('drag-ghost'), t0 = performance.now(), s0 = L.scrollTop; let n = 0; const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : res({ fps: n, moved1s: L.scrollTop - s0, top: L.scrollTop, max: L.scrollHeight - L.clientHeight, list: [Math.round(r.top), Math.round(r.top + L.clientHeight)], farY: Math.round(T.rect(far).y), ghost: g.className, cap: g.textContent, lists: document.querySelectorAll('.skill-list').length, weapon: G.weaponBasic() })); requestAnimationFrame(f); }), g.far);
      throw new Error('贴边自动滚动没有把远处的孔带进视野：' + JSON.stringify({ far: g.far, ptr: [Math.round(g.x), Math.round(g.bottom - 6)], ...d }));
    });
    // 先挪进来（离开贴边带就不再滚），再对准孔的中心
    let b = await ev((s) => T.rect(s), g.far);
    await page.mouse.move(b.x, b.y, { steps: 4 });
    b = await ev((s) => T.rect(s), g.far);
    await page.mouse.move(b.x, b.y);
    await frames(2);
    const mid = await ev((far) => ({ cap: document.querySelector('#drag-ghost em').textContent, hover: document.querySelector(far).classList.contains('drop-hover'), top: document.querySelector('.skill-list').scrollTop }), g.far);
    await page.mouse.up();
    const r = await ev((g) => ({ e: G.save.sockets.ember.slice(), t: G.save.sockets[g.skill].slice() }), g);
    assert(mid.hover && mid.cap.startsWith('镶进 ') && r.e[0] === null && r.t[g.idx] === 'multi', '自动滚到远处的孔上松手应把宝石挪过去：' + JSON.stringify({ g, mid, r }));
    await closePanel();
  });
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
    assert(s.sum.bar.join() === 'ember,,,' && Object.keys(s.sum.skills).join() === 'ember' && /^basic_(blade|staff|wand)$/.test(s.sum.basic) && s.sum.cur.dust === 2, '新存档内容不对：' + JSON.stringify({ bar: s.sum.bar, skills: s.sum.skills, basic: s.sum.basic }));
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
    assert(r.slots === 4 && /^ember,basic_(blade|staff|wand),,$/.test(r.bar) && r.icons === 'true,true,false,false', '技能栏不对（左键掷焰、右键起手武器的普攻）：' + r.bar + ' / 图标 ' + r.icons);
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
    // test:func 里只等它画完（安全超时 5 分钟，机器忙时也不误报）；「120 秒内画完」的计时断言在 test:timed 里（计时｜图标预热）
    await until(() => G.icons.ready(), null, 300000).catch(() => {
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

  await step('镜头与远程怪：脚下能看到 7.5 以上、头顶 9.5 以上（卡通风格的近镜头）；屏幕下方画面外的喷吐者先走进画面再开火', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, W = G.world;
      const c = S.zone.circles[1];
      T.tp(c.x, c.z - 6.5);
      T.settle();
      const vw = innerWidth, vh = innerHeight;
      const on = (q) => q.ok && q.x >= 0 && q.x <= vw && q.y >= 0 && q.y <= vh;
      const out = { down: on(W.project(P.x, 0, P.z + 7.5)), up: on(W.project(P.x, 0, P.z - 9.5)), py: W.project(P.x, 0, P.z).y / vh };
      // 喷吐者放在正下方 11 处：在画面外（或技能栏后面），算不得看得见
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
      // zones-polish：「首颗辅助宝石」的前提是存档里还没有辅助宝石。区域加长、小怪 ×2 以后，前面几步的技能偶尔会打死起点附近的小怪，
      // 掉的辅助宝石被自动拾取，这一步就偶尔随机失败。这里把前提写明：先清空，断言照旧
      G.save.supports.length = 0;
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
  await step('learnAll：14 个技能（裂石击已删除）与 20 个辅助宝石全部到手（混沌流加了黑洞 / 黑旋风 / 黑焰与混沌注入）；右键格不放技能', async () => {
    const r = await ev(() => {
      G.debug.learnAll();
      return { skills: Object.keys(G.save.skills).length, sups: G.save.supports.length, bar: G.save.bar.slice(), cleave: !!G.SKILLS.cleave || G.GEM_SKILLS.indexOf('cleave') >= 0 };
    });
    assert(r.skills === 14 && r.sups === 20 && [0, 2, 3].every((i) => r.bar[i]) && r.bar[1] === null && !r.cleave, JSON.stringify(r));
  });

  for (let i = 0; i < SKILL_IDS.length; i++) {
    const id = SKILL_IDS[i];
    const slot = BAR_SLOTS[i % 3];
    await step('技能：' + id + ' 绑定到' + INPUT_NAME[slot] + '，按住后对敌人造成伤害', async () => {
      const dist = id === 'whirl' ? 2.4 : 5;
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
        // 远程武器的 R 不进冷却、由量表卡住（rgauge）；每种武器的普攻 basic_<type> 也得在（不进宝石池）
        if (!(sk && sk.weaponOnly && sk.tags.indexOf('weapon') >= 0 && sk.wtype === B[b].type && (B[b].ranged ? sk.rgauge && !sk.cd : sk.cd > 0) && G.GEM_SKILLS.indexOf(B[b].wskill) < 0)) out.bad.push('skill:' + b);
        if (!(G.SKILLS['basic_' + B[b].type] && G.SKILLS['basic_' + B[b].type].basic && G.GEM_SKILLS.indexOf('basic_' + B[b].type) < 0)) out.bad.push('basic:' + b);
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
        const c = G.skillCtx('blade'), e = G.skillCtx('ember'), t = G.skillCtx('thrall');
        return { cl: c.base.phys.map((v) => +v.toFixed(3)), clSpeed: c.speed, clDps: G.skillDps(c), em: JSON.stringify(e.base), emSpeed: e.speed, th: JSON.stringify(t.base), wm: c.wm, k: c.levelK, attack: c.attack, emAttack: e.attack };
      };
      try {
        const lv = (save.skills.blade || 1);
        save.equip.weapon = mk(0, 9);
        const a = read();
        save.equip.weapon = mk(0, 15);
        const b = read();
        save.equip.weapon = mk(3, 9);
        const dg = read();
        delete save.equip.weapon;
        const f = read();
        const wA = G.weaponBaseDmg(0, 9);
        out.formula = Math.abs(a.cl[0] - wA[0] * G.SKILLS.blade.wm * (1 + G.ATTACK_GEM_LVL * (lv - 1))) < 0.01 && a.wm === G.SKILLS.blade.wm && a.attack && !a.emAttack;
        out.scale = b.cl[1] / a.cl[1];
        out.spellSame = a.em === b.em && a.em === f.em && a.em === dg.em && a.th === f.th && a.emSpeed === dg.emSpeed;
        out.aps = +(dg.clSpeed / a.clSpeed).toFixed(3);
        out.fists = f.cl.join() === [2 * a.wm * a.k, 4 * a.wm * a.k].map((v) => +v.toFixed(3)).join();
        out.fistDps = f.clDps / a.clDps;
        // 有冷却的闪袭：出手次数由冷却定，攻速改为折进每一击（战锤 0.8 / 双匕 1.2 的平均伤害 × 攻速一样时，闪袭每一击一样）
        save.skills.blink = save.skills.blink || 1;
        const bl = (b, base) => { const w = mk(b, 9); w.wbase = base.slice(); G.refreshWeapon(w); save.equip.weapon = w; G.computeStats(); return G.skillCtx('blink').base.phys[1]; };
        out.cdAps = { hammer: +bl(4, [10, 15]).toFixed(3), daggers: +bl(3, [10, 15]).toFixed(3), blade: +bl(0, [10, 15]).toFixed(3), bladeDg: +G.skillCtx('blade').base.phys[1].toFixed(3) };
        // 换装评估：更强的武器 → 飞刃（攻击技能，裂石击已删除）秒伤上升、角标 ▲；评估结果和真换上去一致
        save.bar[0] = 'blade';
        save.equip.weapon = mk(0, 9);
        G.computeStats();
        const strong = mk(0, 15);
        strong.uid = 'vd-strong-' + Date.now();
        save.bag.push(strong);
        const v = G.ui.verdict(strong);
        const before = G.skillDps(G.skillCtx('blade'));
        G.equip(strong);
        const after = G.skillDps(G.skillCtx('blade'));
        const line = v.lines.find((l) => l.label === G.SKILLS.blade.name + ' 秒伤');
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
    assert(Math.abs(ca.hammer / ca.blade - 0.8) < 0.002 && Math.abs(ca.daggers / ca.blade - 1.2) < 0.002 && ca.bladeDg < ca.daggers, '有冷却的攻击技能应把武器攻速折进每一击：' + JSON.stringify(ca));
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
        // 缓冲：右键挥砍（刃的普攻「挥斩」）途中按 R，挥完立刻出武器技
        lane();
        save.equip.weapon = G.rollItem(5, 0, 'weapon', 0);
        G.computeStats();
        const tgt = T.mob('brute', 2.2, 0);
        T.aim(tgt.x, tgt.z);
        G.input.tap[1] = 0.3;
        G.tick(1 / 60);
        const first = P.cast && P.cast.id;
        G.input.tap[1] = 0;
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
    assert(r.buffer.first === 'basic_blade' && r.buffer.at >= 0, '挥砍途中按下的 R 应在挥完后放出：' + JSON.stringify(r.buffer));
    assert(r.feel.chain >= 2 && r.feel.poise > 30, '武器技应计入连击并削架势：' + JSON.stringify(r.feel));
    assert(r.elem === 'cold' && r.bu.base.indexOf('cold') >= 0 && (r.bu.cold > 0 || r.bu.frozen), '地脉涌应取加成最高的元素并累积其异常值：' + JSON.stringify(r));
    return '墙前伤害 ' + Object.keys(w).map((k) => k + ' ' + w[k].front).join(' / ');
  });

  await step('魂潮：4 只魂火扑向准星附近的敌人、碰到即炸开，伤害按召唤物算（吃召唤物伤害，不吃你自己的伤害加成）；没有召唤物也能用；有召唤物时令其狂热（攻击 / 移动更快）', async () => {
    const r = await ev(() => {
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
      G.save.bar = bar0;
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
        // 4) 处决基数：同样武器秒伤的战锤和双匕一样重（技能栏清空，基数取右键的武器普攻：两种连招按武器秒伤对齐过）
        T.arena();
        save.bar = [null, null, null, null];
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

  await step('右键接管（武器普攻改版）：任何武器（含空手）右键都是这把武器的普攻 basic_<类型>；右键绑不上别的、新学的技能也不进右键；右键格残留的旧数据挪到空格、三格都满时收进 rmbKeep，绑上之后取出；存档刷新后不丢', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        for (const id of ['blade', 'ember', 'arc']) {
          save.skills[id] = save.skills[id] || 1;
          save.sockets[id] = save.sockets[id] || [null, null, null];
        }
        save.bar = ['blade', null, 'ember', null];
        save.rmbKeep = null;
        G.computeStats();
        out.before = G.slotSkill(1);
        for (const b of [8, 9, 5, 10, 11]) {
          RW.arm(b);
          const rw = G.rangedWeapon();
          (out.rw = out.rw || []).push(rw.type + ':' + rw.family + ':' + rw.basic + ':' + rw.gauge.kind + ':' + G.slotSkill(1) + ':' + (save.bar[1] === null));
        }
        // 近战 / 施法 / 魂幡 / 空手：右键同样是自己的普攻
        out.melee = [];
        for (const b of [0, 1, 2, 3, 4, 6, 7, -1]) {
          if (b >= 0) save.equip.weapon = G.rollItem(5, 0, 'weapon', b);
          else delete save.equip.weapon;
          G.computeStats();
          const want = 'basic_' + (b >= 0 ? G.BASES.weapon[b].type : 'fists');
          out.melee.push(G.slotSkill(1) === want && G.weaponBasic() === want && save.bar[1] === null ? 'ok' : b + ':' + G.slotSkill(1));
        }
        save.equip.weapon = T.stdBlade(10);
        G.computeStats();
        // 右键绑不上；别的格子照常
        out.bindR = G.bindSkill(1, 'blade');
        out.bindE = G.bindSkill(3, 'arc');
        out.barE = save.bar.join();
        // 新学的技能：右键不算空格
        delete save.skills.meteor;
        save.bar = ['blade', null, null, 'arc'];
        G.computeStats();
        G.state.loot.length = 0;
        const l = G.spawnLoot('skill', { id: 'meteor', lvl: 3 }, P.x, P.z);
        G.pickup(l);
        out.learn = save.bar.join();
        // 按右键：放出的是普攻
        const tg = T.mob('brute', 6, 0);
        RW.arm(10);
        RW.hold(40, tg);
        out.cast = { hp: Math.round(tg.maxHp - tg.hp), shots: G.state.stats.rShots || 0 };
        // 存档：刷新（读档）后右键仍是普攻、技能栏不变
        G.persist();
        G.loadSave();
        G.computeStats();
        out.reload = save.rmbKeep + '|' + save.bar.join() + '|' + G.slotSkill(1);
        // 右键格里残留着技能（理论上绑不上；直接写进去模拟旧数据）：挪到第一个空格
        save.bar = ['blade', 'ember', 'meteor', null];
        G.computeStats();
        out.stray = save.bar.join() + '|' + save.rmbKeep;
        // 三格都满：收进 rmbKeep；绑到任意一格就取出来
        save.bar = ['blade', 'arc', 'meteor', 'ember'];
        G.computeStats();
        out.full = save.bar.join() + '|' + save.rmbKeep;
        G.bindSkill(0, 'arc');
        out.rebind = save.bar.join() + '|' + save.rmbKeep;
        save.bar = ['blade', null, 'meteor', 'arc'];
        save.rmbKeep = null;
        // 换装评估：刃 → 机炮时右键「挥斩 → 开火」，比两边右键的秒伤（不出 NaN）；试穿完技能栏原样
        save.equip.weapon = T.stdBlade(10);
        G.computeStats();
        const fin = (v) => isFinite(v.score) && v.lines.every((l) => !/NaN/.test(l.text) && (l.pct === null || isFinite(l.pct)));
        const gun = G.rollItem(40, 2, 'weapon', 8);
        gun.uid = 'vd-gun-' + Date.now();
        const vg = G.ui.verdict(gun);
        out.vdGun = { badge: vg.badge, fin: fin(vg), rmb: (vg.lines.find((x) => x.label === '右键') || {}).text, rd: !!vg.lines.find((x) => x.label === '右键秒伤'), bar: save.bar.join() + '|' + save.rmbKeep };
        // 远程 → 近战：反过来
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
      } finally {
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        save.rmbKeep = null;
        G.computeStats();
      }
      return out;
    }, rangedSetup);
    assert(r.before === 'basic_blade', '拿着刃时右键应是「挥斩」：' + r.before);
    assert(r.rw.length === 5 && r.rw.every((x) => /:basic_\w+:(heat|focus):basic_\w+:true$/.test(x)), '拿上远程武器时右键应是武器普攻：' + r.rw.join(' | '));
    assert(/^gatling:gun:basic_gatling:heat/.test(r.rw[0]) && /^eagle:bow:basic_eagle:focus/.test(r.rw[2]), '武器族 / 量表不对：' + r.rw.join(' | '));
    assert(r.melee.every((x) => x === 'ok'), '近战 / 施法 / 魂幡 / 空手的右键应是各自的普攻：' + r.melee.join(' | '));
    assert(r.bindR === false && r.bindE === true && r.barE === 'blade,,ember,arc', '右键应绑不上、别的格子照常：' + JSON.stringify(r));
    assert(r.learn === 'blade,,meteor,arc', '新学的技能应放进 Q（右键不算空格）：' + r.learn);
    assert(r.cast.hp > 0 && r.cast.shots > 0, '按右键应射出武器普攻：' + JSON.stringify(r.cast));
    assert(r.reload === 'null|blade,,meteor,arc|basic_huntbow', '读档后右键仍是普攻、技能栏不变：' + r.reload);
    assert(r.stray === 'blade,,meteor,ember|null', '右键格残留的技能应挪到第一个空格：' + r.stray);
    assert(r.full === 'blade,,meteor,ember|arc' && r.rebind === 'arc,,meteor,ember|null', '三格都满时应收进 rmbKeep，绑上之后取出：' + JSON.stringify({ full: r.full, rebind: r.rebind }));
    assert(r.vdGun.fin && r.vdGun.badge !== 'eq' && r.vdGun.rmb === '「挥斩」 → 「开火」' && r.vdGun.rd && r.vdGun.bar === 'blade,,meteor,arc|null', '近战换远程的评估应列出右键的变化、数值有限、试穿后技能栏不变：' + JSON.stringify(r.vdGun));
    assert(r.vdBlade.fin && r.vdBlade.rmb === '「开火」 → 「挥斩」', '远程换近战的评估应列出右键换回来：' + JSON.stringify(r.vdBlade));
    assert(r.vdBow.fin && r.vdBow.badge === 'up' && r.vdBow.basic, '弓换更强的弓应把射击的秒伤算进去：' + JSON.stringify(r.vdBow));
    return r.rw.map((x) => x.split(':').slice(0, 2).join('/')).join('、') + ' · 近战 ' + r.melee.length + ' 种';
  });

  await step('武器普攻卡：3 个辅助孔属于卡片（换武器时宝石不动），对任一种普攻适配就能镶（回响给灵弹 / 疾咒、驭灵给魂引；坚骨哪种都不适配），按当前普攻的标签生效（多重投射对机炮生效、对喷枪不生效；扩域反过来）；伤害按武器伤害 × 倍率；存档修正', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        for (const id of ['multi', 'expanse', 'brutal', 'echo', 'dominion', 'ossify', 'pierce', 'chain', 'leech']) if (save.supports.indexOf(id) < 0) save.supports.push(id);
        const card = G.BASIC_CARD;
        save.sockets[card] = [null, null, null];
        RW.arm(8);
        out.fits = ['multi', 'expanse', 'brutal', 'echo', 'dominion', 'ossify', 'pierce', 'chain', 'leech', 'haste'].map((s) => s + ':' + G.supportFits(card, s)).join(' ');
        out.sock = [G.socketSupport(card, 0, 'multi'), G.socketSupport(card, 1, 'expanse'), G.socketSupport(card, 2, 'ossify')];
        const g = G.skillCtx('basic_gatling');
        out.gat = { proj: g.proj, area: g.area, active: G.basicSupports('basic_gatling').join() };
        // 普攻伤害 = 武器伤害 × wm × 等级加成，出手节奏乘武器攻速
        const w = G.weaponStats(save.equip.weapon);
        out.formula = Math.abs(g.base.phys[0] - w.min * G.SKILLS.basic_gatling.wm * g.levelK * 0.75) < 1e-6 || Math.abs(g.base.phys[0] - w.min * G.SKILLS.basic_gatling.wm * g.levelK) < 1e-6;
        RW.arm(9);
        const f = G.skillCtx('basic_flamer');
        out.fla = { proj: f.proj, area: f.area, active: G.basicSupports('basic_flamer').join(), fire: Object.keys(f.base).join() };
        out.still = save.sockets[card].join();
        // 存档：卡片的宝石刷新后还在；不适配的（坚骨）、没有的宝石被丢掉
        save.sockets[card] = ['multi', 'expanse', 'ossify'];
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
    assert(/multi:true/.test(r.fits) && /expanse:true/.test(r.fits) && /brutal:true/.test(r.fits) && /echo:true/.test(r.fits) && /dominion:true/.test(r.fits) && /ossify:false/.test(r.fits) && /pierce:true/.test(r.fits) && /chain:true/.test(r.fits) && /leech:true/.test(r.fits), '武器普攻卡能镶的辅助不对：' + r.fits);
    assert(r.sock[0] && r.sock[1] && !r.sock[2], '镶嵌结果不对：' + JSON.stringify(r.sock));
    assert(r.gat.proj === 3 && r.gat.area === 1 && r.gat.active === 'multi', '机炮应吃多重投射、不吃扩域：' + JSON.stringify(r.gat));
    assert(r.fla.proj === 1 && r.fla.area > 1.3 && r.fla.active === 'expanse' && r.fla.fire === 'fire', '喷枪应吃扩域、不吃多重投射，伤害全是火焰：' + JSON.stringify(r.fla));
    assert(r.formula, '普攻伤害应是武器伤害 × 倍率');
    assert(r.still === 'multi,expanse,', '换远程武器时卡上的宝石不该动：' + r.still);
    assert(r.saved === 'multi,expanse,', '存档里卡片的宝石应保留、不适配的丢掉：' + r.saved);
    assert(r.perShot === 3 && r.multiShots >= 3, '多重投射的机炮每次应出 3 发：' + JSON.stringify([r.perShot, r.multiShots]));
    return '机炮 ' + r.gat.active + ' · 喷枪 ' + r.fla.active + ' · 存档 ' + r.saved;
  });

  // ------------------------------------------------------------------ 武器普攻（右键）：近战连招 / 施法 / 魂幡 / 空手
  await step('武器普攻：每种近战武器和空手的右键是各自的连招（刃 3 段、双匕 4 段、战锤 3 段、太刀 3 段、空手 3 段），按住一路打完、动作和数据对得上、最后一段是终结；长杖 / 短杖 / 魂幡的右键各放自己的普攻并造成伤害；都不耗魔力', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, W = G.world, out = { melee: {}, cast: {} };
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        for (const k of Object.keys(save.sockets)) save.sockets[k] = [null, null, null];
        for (const [b, type] of [[0, 'blade'], [3, 'daggers'], [4, 'hammer'], [6, 'katana'], [-1, 'fists']]) {
          T.lane();
          if (b >= 0) RW.arm(b);
          else { delete save.equip.weapon; G.computeStats(); }
          const id = 'basic_' + type, sk = G.SKILLS[id];
          const tg = T.mob('brute', 2.4, 0, { hp: 1e7 });
          tg.mass = 1e6;
          const m0 = P.mana, fin0 = S.stats.finishers, h0 = tg.hp;
          const seq = [], clips = [];
          let last = null;
          for (let i = 0; i < 300 && seq.length < sk.combo.length + 1; i++) {
            T.aim(tg.x, tg.z);
            G.input.mouse.b[2] = true;
            G.tick(1 / 60);
            const c = P.cast;
            if (c && c.st && c !== last) { last = c; seq.push(c.step); clips.push(W.clipOf(P.ent)); }
          }
          G.input.mouse.b[2] = false;
          G.debug.step(1);
          out.melee[type] = {
            id: G.weaponBasic(), n: sk.combo.length, seq: seq.join(), clips: clips.join(), want: sk.combo.map((c) => c.clip).concat([sk.combo[0].clip]).join(),
            fin: S.stats.finishers - fin0, finW: sk.combo[sk.combo.length - 1].w, dmg: h0 - tg.hp, mana: +(m0 - P.mana).toFixed(3),
            weaponOnly: sk.weaponOnly && sk.basic && G.GEM_SKILLS.indexOf(id) < 0, tags: sk.tags.join(),
          };
        }
        // 施法 / 召唤：右键点几下，打中准星附近的靶子
        for (const [b, type] of [[1, 'staff'], [2, 'wand'], [7, 'banner']]) {
          T.lane();
          RW.arm(b);
          G.clearMinions();
          const tg = T.mob('brute', 6, 0, { hp: 1e7 });
          const m0 = P.mana, h0 = tg.hp, sp0 = S.projectiles.length;
          let proj = 0, cast = null;
          for (let i = 0; i < 90; i++) {
            T.aim(tg.x, tg.z);
            G.input.mouse.b[2] = true;
            G.tick(1 / 60);
            if (P.cast && !cast) cast = P.cast.id + ':' + W.clipOf(P.ent);
            proj = Math.max(proj, S.projectiles.length - sp0);
          }
          G.input.mouse.b[2] = false;
          G.debug.step(1.5);
          const ctx = G.skillCtx('basic_' + type);
          out.cast[type] = { id: G.weaponBasic(), cast, proj, dmg: h0 - tg.hp, mana: +(m0 - P.mana).toFixed(3), spell: ctx.sk.tags.indexOf('spell') >= 0, attack: ctx.attack, cost: ctx.cost, el: Object.keys(ctx.base).join() };
        }
        // 图标：每个普攻都有自己的程序化图标
        out.icons = Object.keys(G.SKILLS).filter((id) => G.SKILLS[id].basic).map((id) => id + ':' + /^data:image\/png/.test(G.icons ? G.icons.url('sk-' + id) : 'data:image/png'));
      } finally {
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        G.clearMinions();
        T.arena();
      }
      return out;
    }, rangedSetup);
    const want = { blade: 3, daggers: 4, hammer: 3, katana: 3, fists: 3 };
    for (const k of Object.keys(want)) {
      const m = r.melee[k];
      const seq = Array.from({ length: want[k] }, (_, i) => i).concat([0]).join();
      assert(m.id === 'basic_' + k && m.n === want[k] && m.seq === seq, k + '：按住右键应一路打完 ' + want[k] + ' 段再从头来：' + JSON.stringify(m));
      assert(m.clips === m.want, k + '：每段的动作应和数据一致：' + JSON.stringify(m));
      assert(m.fin === 1 && m.finW === 2 && m.dmg > 0 && m.mana === 0 && m.weaponOnly && /attack/.test(m.tags) && /melee/.test(m.tags), k + '：终结 / 伤害 / 不耗魔力 / 不进宝石池：' + JSON.stringify(m));
    }
    for (const k of ['staff', 'wand', 'banner']) {
      const c = r.cast[k];
      const clip0 = { staff: 'b_staffA', wand: 'b_wandL', banner: 'b_point' }[k]; // 长杖 / 短杖有自己的出手动作，魂幡仍是朝前一点
      assert(c.id === 'basic_' + k && c.cast && c.cast.indexOf('basic_' + k + ':' + clip0) === 0 && c.dmg > 0 && c.mana === 0 && c.cost === 0 && c.spell && !c.attack, k + '：右键应放出自己的普攻（朝前点出的动作）、打中靶子、不耗魔力、是法术：' + JSON.stringify(c));
    }
    assert(r.cast.staff.proj >= 1 && r.cast.banner.proj >= 1 && r.cast.wand.proj === 0, '灵弹 / 魂引是投射物，疾咒是瞬发的咒光：' + JSON.stringify(r.cast));
    assert(r.icons.length === 15 && r.icons.every((x) => /:true$/.test(x)), '每个普攻都应有图标：' + r.icons.join(' '));
    return Object.keys(r.melee).map((k) => k + ' ' + r.melee[k].seq).join(' · ');
  });

  await step('近战连招的节奏：停手约 0.55 秒（收招之后）从头再来、翻滚 / 放别的技能也重置；收招途中轻点右键记进缓冲、一到能接招的时刻接下一段；换武器时换成新武器的连招、从第一段起；迅捷让整串一起变快', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        RW.arm(3); // 双匕：4 段
        for (const k of Object.keys(save.sockets)) save.sockets[k] = [null, null, null];
        save.bar = ['ember', null, null, null];
        G.computeStats();
        const A = T.mob('brute', 2.4, 0, { hp: 1e7 });
        A.mass = 1e6;
        out.a = T.swing(A).step;
        out.b = T.swing(A).step;
        // 收招途中轻点：缓冲着，到可接招的那一刻放出下一段
        let c0 = P.cast;
        G.input.tap[1] = G.bufferTime('cast');
        const tap = G.input.tap[1];
        let at = -1;
        for (let i = 0; i < 60 && at < 0; i++) { T.aim(A.x, A.z); G.tick(1 / 60); if (P.cast && P.cast !== c0) at = c0.t - c0.cancelT; }
        out.buf = { tap, at, step: P.cast && P.cast.step };
        G.debug.step(0.4);
        // 停手：窗口里还算接上，过了窗口从头来
        G.debug.step(0.2);
        out.within = T.swing(A).step; // 3（终结）
        G.debug.step(1.4);
        out.reset = T.swing(A).step; // 0
        // 翻滚重置
        out.mid = T.swing(A).step; // 1
        P.roll.cd = 0;
        G.dodge();
        G.debug.step(0.6);
        out.afterRoll = T.swing(A).step; // 0
        // 放别的技能重置
        T.swing(A);
        P.mana = P.maxMana;
        G.input.tap[0] = 0.3;
        for (let i = 0; i < 40 && !(P.cast && P.cast.id === 'ember' && P.cast.fired); i++) { T.aim(A.x, A.z); G.tick(1 / 60); }
        G.debug.step(0.6);
        out.afterSkill = T.swing(A).step; // 0
        // 换武器：连段跟着新武器的普攻、从第一段起
        T.swing(A);
        out.before = P.combo.id + ':' + P.combo.step;
        RW.arm(4); // 战锤
        const s = T.swing(A);
        out.swap = { id: P.cast && P.cast.id, step: s.step };
        // 迅捷（武器普攻卡）：每一段都按出手速度缩短
        G.debug.step(1.5);
        const t0 = G.skillCtx('basic_hammer').time;
        if (save.supports.indexOf('haste') < 0) save.supports.push('haste');
        G.socketSupport(G.BASIC_CARD, 0, 'haste');
        out.haste = { ratio: G.skillCtx('basic_hammer').time / t0, active: G.basicSupports('basic_hammer').join() };
        const s2 = T.swing(A);
        out.haste.fireT = P.cast.fireT;
        out.haste.want = G.SKILLS.basic_hammer.combo[s2.step].hit / G.skillCtx('basic_hammer').speed;
      } finally {
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        save.sockets[G.BASIC_CARD] = [null, null, null];
        T.arena();
      }
      return out;
    }, rangedSetup);
    assert(r.a === 0 && r.b === 1, '前两段应是 0、1：' + JSON.stringify(r));
    assert(r.buf.tap > 0.2 && r.buf.at >= -1e-6 && r.buf.at < 0.06 && r.buf.step === 2, '收招途中轻点的右键应在可接招的那一刻接出第三段：' + JSON.stringify(r.buf));
    assert(r.within === 3 && r.reset === 0, '窗口内接上终结、停手超过窗口从头来：' + JSON.stringify(r));
    assert(r.mid === 1 && r.afterRoll === 0, '翻滚应让连段从头来：' + JSON.stringify(r));
    assert(r.afterSkill === 0, '放别的技能应让连段从头来：' + JSON.stringify(r));
    assert(/^basic_daggers:[1-3]$/.test(r.before) && r.swap.id === 'basic_hammer' && r.swap.step === 0, '换了武器应换成新武器的连招、从第一段起：' + JSON.stringify(r));
    assert(Math.abs(r.haste.ratio - 0.8) < 0.01 && r.haste.active === 'haste' && Math.abs(r.haste.fireT - r.haste.want) < 1e-6, '迅捷应让整串连招按出手速度变快：' + JSON.stringify(r.haste));
    return '缓冲在可接招后 ' + (r.buf.at * 1000).toFixed(0) + ' ms 接上';
  });

  await step('长杖的普攻「灵弹」：三下一轮（两枚小弹接一枚蓄力重弹，各有各的动作），停手约 0.55 秒 / 翻滚后从第一下起；迅捷让三下一起变快；不耗魔力；重弹炸开按元素追加：火留燃地（之后还在掉血）、冰溅出 4 根冰棱打中爆炸圈外的敌人并冰缓炸到的、雷弹向圈外最近的 2 个敌人', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, W = G.world, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      const top0 = G.topElem;
      const sk = G.SKILLS.basic_staff;
      // 按住右键直到出下一发（返回这一发的段、动作、时刻）
      const cast = (A, max) => {
        const c0 = P.cast;
        for (let i = 0; i < (max || 120); i++) {
          T.aim(A.x, A.z);
          G.input.mouse.b[2] = true;
          G.tick(1 / 60);
          const c = P.cast;
          if (c && c !== c0 && c.id === 'basic_staff') {
            G.input.mouse.b[2] = false;
            return { step: c.step, clip: W.clipOf(P.ent), fireT: c.fireT, cancelT: c.cancelT, st: !!c.st };
          }
        }
        G.input.mouse.b[2] = false;
        return { step: -1 };
      };
      try {
        T.lane();
        RW.arm(1, 20);
        for (const k of Object.keys(save.sockets)) save.sockets[k] = [null, null, null];
        G.computeStats();
        P.combo.step = 0;
        P.combo.t = 0;
        const A = T.mob('husk', 5, 0, { hp: 1e7 });
        A.mass = 1e6;
        const m0 = P.mana;
        // 节奏：0、1、2（重弹）、0
        out.seq = [cast(A), cast(A), cast(A), cast(A)];
        out.mana = +(m0 - P.mana).toFixed(3);
        out.cost = G.skillCtx('basic_staff').cost;
        // 停手：过了窗口从头来；翻滚也从头来
        G.debug.step(1.4);
        out.reset = cast(A).step;
        cast(A);
        G.debug.step(0.5);
        P.roll.cd = 0;
        G.dodge();
        G.debug.step(0.5);
        out.afterRoll = cast(A).step;
        // 迅捷：每一下的生效 / 可接招时刻都按施法速度缩短
        G.debug.step(1.5);
        const sp0 = G.skillCtx('basic_staff').speed;
        if (save.supports.indexOf('haste') < 0) save.supports.push('haste');
        G.socketSupport(G.BASIC_CARD, 0, 'haste');
        const sp1 = G.skillCtx('basic_staff').speed;
        const h = [cast(A), cast(A), cast(A)];
        out.haste = { k: sp1 / sp0, ok: h.every((c, i) => Math.abs(c.cancelT - sk.cyc[i].time / sp1) < 1e-6 && Math.abs(c.fireT - (sk.cyc[i].time * (sk.cyc[i].hit || 0.5)) / sp1) < 1e-6), steps: h.map((c) => c.step).join() };
        save.sockets[G.BASIC_CARD] = [null, null, null];
        G.computeStats();
        // 元素：直接放一发重弹（第三下），等它炸开
        const heavy = (el, setup) => {
          T.lane();
          G.topElem = () => el;
          const M = T.mob('husk', 4, 0, { hp: 1e7 });
          M.mass = 1e6;
          const side = setup(M);
          for (const e of [M].concat(side)) e.buTh = 1e15; // 靶子血量改大了：异常阈值也抬上去，不让命中自带的冰冻 / 感电 / 爆燃掺进来
          const ctx = G.skillCtx('basic_staff');
          const k0 = S.stats['cb' + el[0].toUpperCase() + el.slice(1)] || 0, a0 = S.stats.cbArcHits || 0;
          T.aim(M.x, M.z);
          P.face = Math.atan2(M.x - P.x, M.z - P.z);
          G.execSkill(ctx, sk.cyc[2]);
          const proj = S.projectiles.filter((p) => p.burst && p.burst.el === el).map((p) => ({ vk: p.vk, ex: p.explode, m: p.blastMult }));
          let boomed = false, shards = [];
          for (let i = 0; i < 90 && !boomed; i++) {
            G.tick(1 / 60);
            boomed = (S.stats['cb' + el[0].toUpperCase() + el.slice(1)] || 0) > k0;
          }
          const chill = +(M.bu ? M.bu.cold : 0).toFixed(2); // 冰缓要在回落之前读
          if (el === 'cold') {
            // 冰棱：每根前方 1.6 米摆一只靶子，看哪几根打中；炸到的主目标不再挨冰棱
            shards = S.projectiles.filter((p) => p.vk === 'ishard');
            shards.forEach((p, i) => { side[i].x = p.x + p.dx * 1.6; side[i].z = p.z + p.dz * 1.6; });
          }
          const hp0 = side.map((e) => e.hp), mh = M.hp;
          G.debug.step(1.2);
          return { boomed, proj, side: side.map((e, i) => +(hp0[i] - e.hp > 0)), sideHit: side.map((e) => +(e.hp < 1e7)), later: mh - M.hp, shards: shards.length, chill, arcs: (S.stats.cbArcHits || 0) - a0, field: G.rangedFields().filter((f) => f.kind === 'cbfire').length };
        };
        out.fire = heavy('fire', () => []);
        out.cold = heavy('cold', (M) => [0, 1, 2, 3].map(() => { const e = T.mob('husk', 4, 6, { hp: 1e7 }); e.mass = 1e6; return e; }));
        out.light = heavy('light', (M) => [[0, 3.4], [0, -3.4], [3.6, 0.2]].map(([dx, dz]) => { const e = G.spawnMob('husk', M.x + dx, M.z + dz, 1, { awake: true }); e.hp = e.maxHp = 1e7; e.atkCd = 1e9; e.speed = 0; e.mass = 1e6; return e; }));
      } finally {
        G.topElem = top0;
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        save.sockets[G.BASIC_CARD] = [null, null, null];
        T.arena();
      }
      return out;
    }, rangedSetup);
    const s = r.seq;
    assert(s.map((c) => c.step).join() === '0,1,2,0' && s.map((c) => c.clip).join() === 'b_staffA,b_staffB,b_staffH,b_staffA' && s.every((c) => !c.st), '灵弹应三下一轮、各段动作对得上（不是近战连招）：' + JSON.stringify(s));
    assert(s[2].cancelT > s[0].cancelT * 1.7 && s[2].fireT > s[0].fireT * 2, '第三下（重弹）应明显慢一拍、先蓄力：' + JSON.stringify(s));
    assert(r.mana === 0 && r.cost === 0, '灵弹不耗魔力：' + JSON.stringify([r.mana, r.cost]));
    assert(r.reset === 0 && r.afterRoll === 0, '停手 / 翻滚后应从第一下起：' + JSON.stringify([r.reset, r.afterRoll]));
    assert(Math.abs(r.haste.k - 1.25) < 0.01 && r.haste.ok && r.haste.steps === '0,1,2', '迅捷应让三下一起按施法速度变快：' + JSON.stringify(r.haste));
    for (const el of ['fire', 'cold', 'light']) {
      const x = r[el];
      assert(x.boomed && x.proj.length === 1 && x.proj[0].vk === 'lbolt3' && x.proj[0].ex === 2.4, el + '：重弹（lbolt3、炸开半径 2.4）应炸开并追加：' + JSON.stringify(x));
    }
    assert(r.fire.field === 1 && r.fire.later > 0 && r.fire.proj[0].m === 1.5, '火：重弹 ×1.5、留一片燃地，炸完之后站在里面的目标还在掉血：' + JSON.stringify(r.fire));
    assert(r.cold.shards === 4 && r.cold.side.reduce((a, b) => a + b, 0) >= 3 && r.cold.chill >= 0.2, '冰：应溅出 4 根冰棱打中前方的敌人、炸到的目标被冰缓：' + JSON.stringify(r.cold));
    assert(r.light.arcs === 2 && r.light.sideHit.reduce((a, b) => a + b, 0) === 2, '雷：电弧应弹向爆炸圈外最近的 2 个敌人（第三个不挨）：' + JSON.stringify(r.light));
    return '节奏 ' + s.map((c) => c.clip).join(' → ') + ' · 冰棱打中 ' + r.cold.side.join('') + ' · 电弧 ' + r.light.sideHit.join('');
  });

  await step('短杖的普攻「疾咒」：左右手交替甩出咒光、弹向旁边 1 个敌人，每次命中叠 1 层咒痕；叠满 5 层的那一下引爆，跳向附近所有带咒痕的敌人（没有咒痕的不挨）、咒痕清空；不耗魔力；4 秒不再叠就消失', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, W = G.world, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        RW.arm(2, 20);
        for (const k of Object.keys(save.sockets)) save.sockets[k] = [null, null, null];
        G.computeStats();
        P.combo.step = 0;
        P.combo.t = 0;
        // A：准星对着的目标；B：A 旁边 2.4 米（咒光弹过去）；D：A 旁边 5 米（弹不到、没有咒痕）
        const A = T.mob('husk', 5, 0, { hp: 1e7 });
        const B = T.mob('husk', 5, 2.4, { hp: 1e7 });
        const D = T.mob('husk', 5, -5, { hp: 1e7 });
        for (const e of [A, B, D]) {
          e.mass = 1e6;
          e.buTh = 1e15; // 不让感电 / 冰冻之类的异常掺进来（感电放电会打到 D）
        }
        T.fix(); // 伤害取中值、不暴击：B 每一下挨的伤害好比
        const m0 = P.mana, p0 = S.stats.cbPops || 0, j0 = S.stats.cbJumps || 0;
        const fires = [];
        let last = null;
        for (let i = 0; i < 240 && fires.length < 5; i++) {
          T.aim(A.x, A.z);
          G.input.mouse.b[2] = true;
          const c0 = P.cast, f0 = c0 && c0.fired;
          const hb = B.hp;
          G.tick(1 / 60);
          if (c0 && c0.id === 'basic_wand' && c0.fired && !f0) fires.push({ a: A.cbMark || 0, b: B.cbMark || 0, d: D.cbMark || 0, clip: last, bHit: hb - B.hp });
          if (P.cast && P.cast !== c0) last = W.clipOf(P.ent);
        }
        G.input.mouse.b[2] = false;
        out.fires = fires;
        out.clips = fires.map((f) => f.clip).join();
        out.pops = (S.stats.cbPops || 0) - p0;
        out.jumps = (S.stats.cbJumps || 0) - j0;
        out.dHp = 1e7 - D.hp;
        out.mana = +(m0 - P.mana).toFixed(3);
        out.cost = G.skillCtx('basic_wand').cost;
        out.glyphs = G.wandMarks().size;
        // 4 秒没再叠：咒痕消失
        G.debug.step(4.3);
        out.after = { b: B.cbMark || 0, size: G.wandMarks().size };
      } finally {
        T.unfix();
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        T.arena();
      }
      return out;
    }, rangedSetup);
    const f = r.fires;
    assert(f.length === 5 && f.slice(0, 4).map((x) => x.a + ':' + x.b).join() === '1:1,2:2,3:3,4:4', '前四下应给目标和弹到的敌人各叠一层咒痕：' + JSON.stringify(f));
    assert(f[4].a === 0 && f[4].b === 1 && r.pops === 1 && r.jumps === 1, '第五下叠满引爆：目标和带咒痕的 B 一起炸、咒痕清空（B 再被这一下的咒光叠回 1 层）：' + JSON.stringify({ f: f[4], pops: r.pops, jumps: r.jumps }));
    assert(f[4].bHit > f[3].bHit * 1.5, '引爆应跳到 B 身上（这一下 B 挨得比平时多）：' + JSON.stringify(f.map((x) => Math.round(x.bHit))));
    assert(r.dHp === 0 && f.every((x) => x.d === 0), '没有咒痕的 D 不该挨引爆：' + r.dHp);
    assert(/^b_wandL,b_wandR,b_wandL,b_wandR,b_wandL$|^b_wandR,b_wandL,b_wandR,b_wandL,b_wandR$/.test(r.clips), '应左右手交替出手：' + r.clips);
    assert(r.mana === 0 && r.cost === 0, '疾咒不耗魔力：' + JSON.stringify([r.mana, r.cost]));
    assert(r.after.b === 0 && r.after.size === 0, '咒痕 4 秒不再叠应消失：' + JSON.stringify(r.after));
    return '咒痕 ' + f.map((x) => x.a).join('→') + ' · 引爆跳 ' + r.jumps;
  });

  await step('魂幡的普攻「魂引」：没有召唤物也能打；伤害按召唤物算（吃召唤物伤害提高，不吃你的物理伤害提高）；每只召唤物 +8%（最多 5 只）；打中的目标成为召唤物的集火目标；召唤物辅助（驭灵）对它生效', async () => {
    const r = await ev((code) => {
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        RW.arm(7, 20);
        G.clearMinions();
        for (const k of Object.keys(save.sockets)) save.sockets[k] = [null, null, null];
        G.computeStats();
        const hit = () => G.avgHit(G.skillCtx('basic_banner'));
        out.base = hit();
        P.S.incPhys = (P.S.incPhys || 0) + 100;
        out.phys = hit();
        P.S.incPhys -= 100;
        P.S.minionDmg = (P.S.minionDmg || 0) + 50;
        out.minionDmg = hit();
        P.S.minionDmg -= 50;
        // 0 只召唤物：照样打中
        const tg = T.mob('brute', 7, 0, { hp: 1e7 });
        S.focus = null;
        const h0 = tg.hp;
        for (let i = 0; i < 40; i++) { T.aim(tg.x, tg.z); G.input.mouse.b[2] = true; G.tick(1 / 60); }
        G.input.mouse.b[2] = false;
        G.debug.step(1.5);
        out.zero = { dmg: h0 - tg.hp, focus: S.focus === tg, minions: S.minions.filter((m) => !m.dead).length };
        // 召唤物越多越痛：3 只仆从 → +24%；7 只 → 封顶 +40%
        const th = G.skillCtx('thrall');
        for (let i = 0; i < 3; i++) G.summonMinion('thrall', P.x - 1, P.z + i - 1, th);
        out.three = hit() / out.base;
        P.S.minionCap = (P.S.minionCap || 0) + 4; // 仆从上限 3：抬到 7 只
        const th7 = G.skillCtx('thrall');
        for (let i = 0; i < 4; i++) G.summonMinion('thrall', P.x - 2, P.z + i - 2, th7);
        out.many = { k: hit() / out.base, n: S.minions.filter((m) => !m.dead).length };
        G.clearMinions();
        // 驭灵（召唤物伤害额外 +30%）镶在武器普攻卡上：对魂引生效；坚骨（召唤物生命）对它没用、镶不上
        if (save.supports.indexOf('dominion') < 0) save.supports.push('dominion');
        if (save.supports.indexOf('ossify') < 0) save.supports.push('ossify');
        out.dom = G.socketSupport(G.BASIC_CARD, 0, 'dominion');
        out.oss = G.supportFits('basic_banner', 'ossify');
        out.domK = hit() / out.base;
      } finally {
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        save.sockets[G.BASIC_CARD] = [null, null, null];
        G.clearMinions();
        T.arena();
      }
      G.save.bar = bar0;
      return out;
    }, rangedSetup);
    assert(Math.abs(r.phys / r.base - 1) < 1e-9 && r.minionDmg / r.base > 1.45, '魂引应吃召唤物伤害、不吃你的物理伤害提高：' + JSON.stringify(r));
    assert(r.zero.dmg > 0 && r.zero.focus && r.zero.minions === 0, '没有召唤物时魂引照样打中、并标记集火目标：' + JSON.stringify(r.zero));
    assert(Math.abs(r.three - 1.24) < 0.005 && r.many.n === 7 && Math.abs(r.many.k - 1.4) < 0.005, '每只召唤物 +8%、最多 5 只：' + JSON.stringify(r));
    assert(r.dom && !r.oss && Math.abs(r.domK - 1.3) < 0.005, '驭灵应对魂引生效、坚骨不适配：' + JSON.stringify(r));
    return '0 只 ' + Math.round(r.base) + ' / 3 只 ×' + r.three.toFixed(2) + ' / 封顶 ×' + r.many.k.toFixed(2);
  });

  await step('存档迁移（武器普攻改版）：学过的裂石击退成同等级的无铭技能宝石，镶在它上面的辅助回到手里；右键上的技能带着辅助挪到第一个空格，三格都满时收进 rmbKeep；改版前拿远程武器时收起来的 rmbKeep 放回空格；读档后会提示一次', async () => {
    const r = await ev(() => {
      const KEY = 'cinder-abyss-save-v1';
      const keep = localStorage.getItem(KEY);
      G.persist();
      const base = JSON.parse(localStorage.getItem(KEY));
      const load = (patch) => {
        const raw = Object.assign(JSON.parse(JSON.stringify(base)), patch);
        localStorage.setItem(KEY, JSON.stringify(raw));
        G.loadSave();
        G.computeStats();
        const s = G.save;
        return { bar: s.bar.join(), keep: s.rmbKeep, skills: Object.keys(s.skills).sort().join(), blank: s.blankGems.join(), sups: s.supports.slice().sort().join(), sock: JSON.stringify(s.sockets), refund: G.cleaveRefund, moved: G.rmbMigrated, basic: G.slotSkill(1) };
      };
      const out = {};
      try {
        const eq = { weapon: Object.assign({}, base.equip.weapon, { baseIdx: 0 }) };
        // 1) 改版前的新角色：裂石击（Lv 6，镶着蛮力 / 迅捷）在左键、掷焰（镶着多重）在右键
        out.a = load({ equip: eq, skills: { cleave: 6, ember: 5 }, supports: ['brutal', 'haste', 'multi'], blankGems: [], rmbKeep: null,
          sockets: { cleave: ['brutal', 'haste', null], ember: ['multi', null, null], wbasic: [null, null, null] }, bar: ['cleave', 'ember', null, null] });
        // 2) 右键上有技能（链雷，镶着连锁）、另外三格都满：收进 rmbKeep，技能和辅助都还在
        out.b = load({ equip: eq, skills: { ember: 3, arc: 3, meteor: 3, blink: 3 }, supports: ['chain'], blankGems: [], rmbKeep: null,
          sockets: { ember: [null, null, null], arc: ['chain', null, null], meteor: [null, null, null], blink: [null, null, null] }, bar: ['ember', 'arc', 'meteor', 'blink'] });
        // 3) 改版前拿着远程武器存的档：右键空着、原来的右键技能收在 rmbKeep，Q 空着 → 放进 Q
        out.c = load({ equip: { weapon: Object.assign({}, base.equip.weapon, { baseIdx: 5 }) }, skills: { ember: 3, arc: 3, nova: 3 }, supports: [], blankGems: [2], rmbKeep: 'arc',
          sockets: { ember: [null, null, null], arc: [null, null, null], nova: [null, null, null] }, bar: ['ember', null, null, 'nova'] });
        // 4) 读档两次：不会再退一次宝石、不会再提示
        G.persist();
        G.loadSave();
        out.again = { blank: G.save.blankGems.join(), refund: G.cleaveRefund, moved: G.rmbMigrated };
        // 提示文字（第 1 份存档）
        load({ equip: eq, skills: { cleave: 6, ember: 5 }, supports: ['brutal', 'haste', 'multi'], blankGems: [], rmbKeep: null,
          sockets: { cleave: ['brutal', 'haste', null], ember: ['multi', null, null], wbasic: [null, null, null] }, bar: ['cleave', 'ember', null, null] });
        const h = G.ui.hints().all.indexOf('basicmig') >= 0;
        out.hint = h;
      } finally {
        if (keep) localStorage.setItem(KEY, keep);
        G.loadSave();
        G.computeStats();
        T.arena();
      }
      return out;
    });
    const a = r.a;
    assert(a.skills === 'ember' && a.blank === '6' && a.refund && a.refund.lvl === 6 && a.refund.sups.join() === 'brutal,haste', '裂石击应退成 Lv 6 无铭宝石、记下取下的辅助：' + JSON.stringify(a));
    assert(a.sups === 'brutal,haste,multi' && !/brutal|haste/.test(a.sock), '镶在裂石击上的辅助应回到手里（仍拥有、不在任何孔里）：' + JSON.stringify(a));
    assert(a.bar === 'ember,,,' && JSON.parse(a.sock).ember[0] === 'multi' && a.basic === 'basic_blade' && a.moved.length === 1 && a.moved[0].id === 'ember' && a.moved[0].to === 0, '右键上的掷焰应带着多重挪到空出来的左键：' + JSON.stringify(a));
    const b = r.b;
    assert(b.bar === 'ember,,meteor,blink' && b.keep === 'arc' && /"arc":\["chain"/.test(b.sock) && b.skills === 'arc,blink,ember,meteor', '三格都满时右键的链雷应收进 rmbKeep，技能和辅助（连锁）都在：' + JSON.stringify(b));
    const c = r.c;
    assert(c.bar === 'ember,,arc,nova' && c.keep === null && c.basic === 'basic_eagle', '远程武器时收起来的链雷应放进空着的 Q：' + JSON.stringify(c));
    assert(r.again.refund === null && r.again.moved === null, '第二次读档不应再迁移 / 提示：' + JSON.stringify(r.again));
    assert(r.hint, '应有「武器普攻改版」的提示');
    return '裂石击 → Lv ' + a.refund.lvl + ' 无铭宝石；掷焰 → 左键；满格 → 收起';
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

  await step('拉弓：准星在正前 / 两侧 / 斜后 / 正后、跨过 ±180°、准星扫过身后，站着 / 边走 / 翻滚后 / 高攻速，弦拉开的那段右手都在肩线的胸口一侧、贴着箭线（不往背后拉、不穿模）', async () => {
    const r = await ev((code) => {
      eval(code);
      const P = G.player, W = G.world, S = G.state, inp = G.input, out = { cases: 0, bad: [], minFront: 9, maxLat: 0, shots: 0 };
      const keepW = G.save.equip.weapon, ctx0 = G.skillCtx;
      let spdK = 1;
      // 高攻速：只在这一步里把出手速度乘上去（拉弓起手跟着缩短）
      G.skillCtx = function (id) {
        const c = ctx0.call(G, id);
        if (spdK !== 1 && c) { c.speed *= spdK; c.time /= spdK; }
        return c;
      };
      const kf = (K, k) => {
        let ka = Math.abs(K[0]);
        if (k <= ka) return K[1];
        for (let i = 2; i < K.length; i += 2) {
          const kb = Math.abs(K[i]);
          if (k <= kb) {
            let t = (k - ka) / (kb - ka);
            t = K[i] < 0 ? t * t * t : t * t * (3 - 2 * t);
            return K[i - 1] + (K[i + 1] - K[i - 1]) * t;
          }
          ka = kb;
        }
        return K[K.length - 1];
      };
      // 关节 j 上偏移 off 处的点（相对脚下，世界朝向）
      const pt = (e, j, off) => {
        const M = e.mdl, m = j * 12, o = off || [0, 0, 0], th = e.group.rotation.y, s = e.group.scale.x, c = Math.cos(th), sn = Math.sin(th);
        const x = M[m] * o[0] + M[m + 1] * o[1] + M[m + 2] * o[2] + M[m + 3], y = M[m + 4] * o[0] + M[m + 5] * o[1] + M[m + 6] * o[2] + M[m + 7], z = M[m + 8] * o[0] + M[m + 9] * o[1] + M[m + 10] * o[2] + M[m + 11];
        return [(x * c + z * sn) * s, y * s, (-x * sn + z * c) * s];
      };
      const keys = (dx, dz) => { const k = inp.keys; k.KeyW = dz < -0.3; k.KeyS = dz > 0.3; k.KeyA = dx < -0.3; k.KeyD = dx > 0.3; };
      try {
        // [弓, 攻速倍率, 状态, 初始朝向（度）, 准星相对朝向（度）, 扫到（度）]
        const CASES = [];
        for (const rel of [0, 90, -90, 135, -135, 180]) CASES.push([5, 1, 'stand', 30, rel]);
        for (const rel of [90, -90, 180]) CASES.push([5, 1, 'move', 30, rel]);
        for (const rel of [0, 180]) CASES.push([5, 1, 'roll', 30, rel]);
        CASES.push([5, 1, 'stand', 170, 20], [5, 1, 'stand', -170, -20], [5, 1, 'sweep', 0, 150, 210]);
        for (const rel of [-90, 180]) CASES.push([5, 2.5, 'stand', 30, rel], [5, 2.5, 'move', 30, rel]);
        for (const b of [10, 13]) CASES.push([b, 1, 'stand', 30, 180], [b, 1, 'move', 30, 90], [b, 2.5, 'stand', 170, 20]);
        for (const [b, k, st, face, rel, rel2] of CASES) {
          T.lane();
          RW.arm(b);
          spdK = k;
          const F = face * Math.PI / 180;
          P.face = P.drawFace = F;
          W.setEnt(P.ent, P.x, P.z, F);
          RW.run(20);
          if (st === 'move') { keys(Math.sin(F), Math.cos(F)); RW.run(20, { x: P.x + Math.sin(F) * 8, z: P.z + Math.cos(F) * 8 }); }
          if (st === 'roll') { keys(Math.sin(F), Math.cos(F)); inp.tapDodge = 0.3; G.tick(1 / 60); keys(0, 0); RW.run(8); }
          const s0 = S.stats.rShots || 0, n = st === 'sweep' ? 80 : 60;
          let mf = 9, ml = 0, worst = null;
          for (let i = 0; i < n; i++) {
            const a = F + (st === 'sweep' ? rel + (rel2 - rel) * i / (n - 1) : rel) * Math.PI / 180;
            if (st === 'move') keys(Math.sin(F), Math.cos(F));
            T.aim(P.x + Math.sin(a) * 8, P.z + Math.cos(a) * 8);
            inp.mouse.b[2] = true;
            G.tick(1 / 60);
            const e = P.ent, c = e.clip;
            const dk = c && c.draw ? kf(c.draw, e.cK) : 0;
            if (!c || !/^fire_/.test(c.name) || dk <= 0) continue;
            const JI = e.rig.JI, hand = pt(e, JI.hR, e.rig.armR.grip), grip = pt(e, JI.hL, e.rig.armL.grip), sR = pt(e, JI.uaR), sL = pt(e, JI.uaL);
            // 躯干前方：两肩连线（左 → 右）转 90°；右手在两肩中点的前方多少
            const sx = sR[0] - sL[0], sz = sR[2] - sL[2], sl = Math.hypot(sx, sz) || 1, fx = sz / sl, fz = -sx / sl;
            const front = (hand[0] - (sR[0] + sL[0]) / 2) * fx + (hand[2] - (sR[2] + sL[2]) / 2) * fz;
            // 箭线：过弓把、沿这一箭的方向；右手离它的水平距离
            const ad = P.cast ? P.cast.aim : a, ax = Math.sin(ad), az = Math.cos(ad), hx = hand[0] - grip[0], hz = hand[2] - grip[2];
            const lat = Math.abs(hx * az - hz * ax);
            // 整段拉弓不许跑到肩线背后；弦拉开四分之一以后（到撒放）还要贴着箭线
            const drawn = dk >= 0.25 && e.cK <= c.k0;
            if (drawn && front < mf) mf = front;
            if (drawn && lat > ml) ml = lat;
            if ((front < (drawn ? 0.02 : 0) || (drawn && lat > 0.06)) && !worst) worst = { i, k: +e.cK.toFixed(2), dk: +dk.toFixed(2), front: +front.toFixed(3), lat: +lat.toFixed(3) };
          }
          inp.mouse.b[2] = false;
          keys(0, 0);
          RW.run(20);
          out.cases++;
          out.shots += (S.stats.rShots || 0) - s0;
          out.minFront = Math.min(out.minFront, mf);
          out.maxLat = Math.max(out.maxLat, ml);
          if (worst || mf > 8) out.bad.push([b, k, st, face, rel, rel2 === undefined ? '' : rel2].join('/') + ' ' + JSON.stringify(worst || '没拉弓'));
        }
      } finally {
        G.skillCtx = ctx0;
        keys(0, 0);
        inp.mouse.b[2] = false;
        G.save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    assert(r.cases >= 24 && r.shots >= r.cases * 2, '拉弓场景没跑起来：' + JSON.stringify(r));
    assert(!r.bad.length, '拉弓时右手跑到肩线背后 / 离开箭线（前方要 ≥ 0.02 米、离箭线 ≤ 0.06 米）：' + r.bad.slice(0, 6).join(' ｜ ') + ' 共 ' + r.bad.length + ' 例');
    return r.cases + ' 个场景、' + r.shots + ' 箭 · 右手最少在肩线前 ' + r.minFront.toFixed(3) + ' 米 · 离箭线最多 ' + r.maxLat.toFixed(3) + ' 米';
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

  await step('枪械的 R：熔光射线按住蓄力、松手一发贯穿一条线、蓄力越久越痛、同时累积火与雷的异常值；焚天炎爆炸开一大圈并留下火场；乱射 3 秒自动打身边的敌人、翻滚也不断、照常走动', async () => {
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
        // 按住 R 蓄力 1.5 秒（期间不出伤害、准星先指着上方的 off，瞄准线跟着走），再转回直线、松手放出
        G.input.tap[4] = 0.3;
        G.input.keys.KeyR = true;
        const t0 = S.time;
        let castT = 0;
        const shots0 = S.stats.beamShots || 0;
        for (let i = 0; i < 60 * 1.9; i++) {
          T.aim(i < 60 ? off.x : P.x + 10, i < 60 ? off.z : P.z);
          G.tick(1 / 60);
          if (P.cast && P.cast.id === 'meltray') castT = S.time - t0;
        }
        out.charging = !!(P.cast && P.cast.id === 'meltray' && P.cast.data && !P.cast.data.shot);
        out.preDmg = line.concat([off]).map((e) => Math.round(e.maxHp - e.hp)).reduce((x, y) => x + y, 0);
        G.input.keys.KeyR = false;
        for (let i = 0; i < 60 * 0.8; i++) {
          T.aim(P.x + 10, P.z);
          G.tick(1 / 60);
          if (P.cast && P.cast.id === 'meltray') castT = S.time - t0;
        }
        out.line = line.map((e) => Math.round(e.maxHp - e.hp));
        out.bu = { fire: +(line[0].bu ? line[0].bu.fire : 0).toFixed(3), light: +(line[0].bu ? line[0].bu.light : 0).toFixed(3) };
        out.offFull = Math.round(off.maxHp - off.hp);
        out.castT = +castT.toFixed(2);
        out.shots = (S.stats.beamShots || 0) - shots0;
        out.kFull = S.stats.beamK;
        // 轻点一下（不蓄力）：伤害只有蓄满的约 30%；准星指着 off 放
        const hpA = line[0].hp, offA = off.hp;
        G.debug.gauge();
        G.input.tap[4] = 0.3;
        for (let i = 0; i < 60 * 1.0; i++) {
          T.aim(off.x, off.z);
          G.tick(1 / 60);
        }
        out.turn = Math.round(offA - off.hp);
        out.lineTap = Math.round(hpA - line[0].hp);
        out.kTap = S.stats.beamK;
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
        const pair = T.mob('husk', 5.2, 1.3, { hp: 1e7 }); // 贴着第一只，吃弹片
        const sp0 = S.stats.wildSplash || 0;
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
        out.wild.splash = (S.stats.wildSplash || 0) - sp0;
        out.wild.pair = Math.round(pair.maxHp - pair.hp);
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
    assert(r.charging && r.preDmg === 0, '按住 R 时应在蓄力、还没出伤害：' + JSON.stringify(r));
    assert(r.offFull === 0 && r.shots === 1 && r.kFull === 1 && r.castT > 1.7 && r.castT < 2.8, '松手应只放一发蓄满的射线、打在松手时准星的方向：' + JSON.stringify(r));
    assert(r.turn > 0 && r.lineTap === 0 && Math.abs(r.kTap - 0.3) < 0.05, '轻点应立刻放出约 30% 伤害的射线、朝着准星：' + JSON.stringify(r));
    assert(r.nova.hit.every((v) => v > 0) && r.nova.far === 0 && r.nova.heat === 0 && r.nova.fields === 1 && r.nova.burn > 0, '焚天炎爆不对：' + JSON.stringify(r.nova));
    assert(r.wsU === 'wildfire' && r.wild.on && r.wild.heat === 0 && r.wild.during && !r.wild.end && r.wild.moved > 3, '乱射应开启、翻滚不断、照常走动、3 秒后结束：' + JSON.stringify(r.wild));
    assert(r.wild.hit.filter((v) => v > 0).length >= 2 && r.wild.shots >= 30 && r.wild.splash > 0 && r.wild.pair > 0, '乱射应自动打身边的敌人、弹片波及旁边的：' + JSON.stringify(r.wild));
    return '射线 ' + r.line.join('/') + '（蓄满 ' + r.castT + 's，轻点 ' + r.turn + '）· 炎爆 ' + r.nova.hit.join('/') + ' + 火场 ' + r.nova.burn + ' · 乱射 ' + r.wild.shots + ' 发';
  });

  await step('熔光射线按机炮普攻折算：蓄满一发打在一排木桩上，每个都吃到 ≥ 7 秒机炮普攻（不镶辅助、转满之后的秒伤），物品等级 10 和 40（带上附加伤害与攻速）都成立；技能卡上的数字和实际打出来的对得上', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = [];
      const keepW = save.equip.weapon;
      const keepSock = (save.sockets[G.BASIC_CARD] || [null, null, null]).slice();
      // 典型的成长：物品等级 40 时身上带着全局附加伤害和攻击速度（折算要把它们一起算进去）；
      // 天赋里的「热度满时普攻更痛 / 热度技更痛」不算，只比折算本身
      const GEAR = { 10: { add: 6, speed: 0 }, 40: { add: 50, speed: 15 } };
      const kit = (il) => {
        P.S.heatDmg = 0;
        P.S.rDmg = 0;
        P.S.addFire = GEAR[il].add;
        P.S.speed = GEAR[il].speed;
        P.speedMult = 1 + GEAR[il].speed / 100;
        G.resetRanged();
      };
      // 木桩：打不死，也不破架势、不积异常（血量是生成之后才改大的，异常阈值还按原来的血量算，会一直触发爆燃 / 破绽，顿帧还会吃掉模拟时间）
      const stake = (x) => {
        const e = T.mob('brute', x, 0, { hp: 1e9 });
        e.buTh = 1e15;
        e.poiseMax = 0;
        return e;
      };
      try {
        save.sockets[G.BASIC_CARD] = [null, null, null]; // 普攻卡上不镶辅助（射线本来就不吃辅助）
        T.fix(0.5); // 伤害取区间中值、不暴击、弹道不散：两边都是确定的数
        for (const il of [10, 40]) {
          T.lane();
          RW.arm(8, il);
          kit(il);
          // 普攻：按住右键 6 秒，取转满之后（3–6 秒）的秒伤
          const d = stake(7);
          let hp3 = 0;
          for (let i = 0; i < 360; i++) {
            T.aim(d.x, d.z);
            G.input.mouse.b[2] = true;
            G.tick(1 / 60);
            if (i === 179) hp3 = d.hp;
          }
          G.input.mouse.b[2] = false;
          const basic = (hp3 - d.hp) / 3;
          RW.run(60);
          // 射线：4 个木桩排成一条线（放在 13 米以内：16 米处的木桩实测几乎打不到，车道那头的射线会被截短），按住 R 1.85 秒（起手 0.3 + 蓄满 1.4）再松手
          T.lane();
          RW.arm(8, il);
          kit(il);
          const line = [4, 7, 10, 13].map(stake);
          G.debug.gauge();
          G.input.tap[4] = 0.3;
          G.input.keys.KeyR = true;
          for (let i = 0; i < 60 * 1.85; i++) { T.aim(P.x + 20, P.z); G.tick(1 / 60); }
          G.input.keys.KeyR = false;
          RW.run(50, { x: P.x + 20, z: P.z });
          const dmg = line.map((e) => Math.round(1e9 - e.hp));
          const avg = dmg.reduce((a, b) => a + b, 0) / dmg.length;
          const ctx = G.skillCtx('meltray');
          out.push({ il, add: P.S.addFire, basic: Math.round(basic), beam: dmg, k: S.stats.beamK, secs: +(avg / basic).toFixed(2), card: Math.round(G.avgHit(ctx)), avg: Math.round(avg) });
        }
      } finally {
        T.unfix();
        G.input.keys.KeyR = false;
        save.sockets[G.BASIC_CARD] = keepSock;
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    for (const o of r) {
      assert(o.add === (o.il >= 40 ? 50 : 6), '测试设的附加伤害没保持住：' + JSON.stringify(o));
      assert(o.k === 1 && o.beam.every((v) => v > 0), '射线应蓄满并打中整排木桩：' + JSON.stringify(o));
      assert(o.secs >= 7 && o.secs <= 9.5, '蓄满一发应折合 7–9.5 秒机炮普攻（物品等级 ' + o.il + '）：' + JSON.stringify(o));
      assert(Math.abs(o.card - o.avg) <= o.avg * 0.1, '技能卡上「蓄满一发」应和实际打出来的对得上：' + JSON.stringify(o));
    }
    assert(r[1].basic > r[0].basic * 2 && Math.abs(r[1].secs - r[0].secs) <= 0.8, '武器升级后普攻和射线应一起涨：' + JSON.stringify(r));
    return r.map((o) => '物品等级 ' + o.il + '：普攻 ' + o.basic + '/s · 射线 ' + o.avg + '（折合 ' + o.secs + ' 秒）').join(' · ');
  });

  await step('焚天炎爆按喷枪普攻折算：火浪加 5 秒火场打在木桩上 ≥ 4.5 秒喷枪普攻（不镶辅助、含余烬的秒伤），物品等级 10 和 40（带上附加伤害与攻速）都成立；技能卡上的整招伤害对得上', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, out = [];
      const keepW = save.equip.weapon;
      const keepSock = (save.sockets[G.BASIC_CARD] || [null, null, null]).slice();
      // 典型的成长：物品等级 40 时身上带着全局附加伤害和攻击速度（折算要把它们一起算进去）；
      // 天赋里的「热度满时普攻更痛 / 热度技更痛」不算，只比折算本身
      const GEAR = { 10: { add: 6, speed: 0 }, 40: { add: 50, speed: 15 } };
      const kit = (il) => {
        P.S.heatDmg = 0;
        P.S.rDmg = 0;
        P.S.addFire = GEAR[il].add;
        P.S.speed = GEAR[il].speed;
        P.speedMult = 1 + GEAR[il].speed / 100;
        G.resetRanged();
      };
      // 木桩：打不死，也不破架势、不积异常（血量是生成之后才改大的，异常阈值还按原来的血量算，会一直触发爆燃 / 破绽，顿帧还会吃掉模拟时间）
      const stake = (x) => {
        const e = T.mob('brute', x, 0, { hp: 1e9 });
        e.buTh = 1e15;
        e.poiseMax = 0;
        return e;
      };
      try {
        save.sockets[G.BASIC_CARD] = [null, null, null];
        T.fix(0.5);
        for (const il of [10, 40]) {
          const arm = () => {
            T.lane();
            RW.arm(9, il);
            kit(il);
          };
          // 普攻：按住右键 4 秒喷一只木桩（含地上的余烬），取 1–4 秒的秒伤
          arm();
          const d = stake(3);
          let hp1 = 0;
          for (let i = 0; i < 240; i++) {
            T.aim(d.x, d.z);
            G.input.mouse.b[2] = true;
            G.tick(1 / 60);
            if (i === 59) hp1 = d.hp;
          }
          G.input.mouse.b[2] = false;
          const basic = (hp1 - d.hp) / 3;
          // 焚天炎爆：贴身的木桩吃火浪，再站在火场里烧满 5 秒
          arm();
          const e = stake(2);
          G.debug.gauge();
          G.input.tap[4] = 0.3;
          RW.run(60 * 5.6);
          const dmg = 1e9 - e.hp;
          const ctx = G.skillCtx('firestorm');
          out.push({ il, add: P.S.addFire, basic: Math.round(basic), dmg: Math.round(dmg), secs: +(dmg / basic).toFixed(2), card: Math.round(G.avgHit(ctx)), fields: G.rangedFields().length });
        }
      } finally {
        T.unfix();
        save.sockets[G.BASIC_CARD] = keepSock;
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    for (const o of r) {
      assert(o.add === (o.il >= 40 ? 50 : 6), '测试设的附加伤害没保持住：' + JSON.stringify(o));
      assert(o.secs >= 4.5 && o.secs <= 7, '火浪加火场应折合 4.5–7 秒喷枪普攻（物品等级 ' + o.il + '）：' + JSON.stringify(o));
      assert(Math.abs(o.card - o.dmg) <= o.dmg * 0.1, '技能卡上「整招伤害」应和实际打出来的对得上：' + JSON.stringify(o));
    }
    assert(r[1].basic > r[0].basic * 2 && Math.abs(r[1].secs - r[0].secs) <= 0.8, '武器升级后普攻和炎爆应一起涨：' + JSON.stringify(r));
    return r.map((o) => '物品等级 ' + o.il + '：普攻 ' + o.basic + '/s · 炎爆 ' + o.dmg + '（折合 ' + o.secs + ' 秒）').join(' · ');
  });

  await step('弓的 R 增益（约 8 秒）：万矢每箭分 5 支追踪箭；一矢穿心必定暴击、贯穿所有；元素满溢火冰雷轮流、异常翻倍、命中炸开；凛冬 3 支寒冰箭、冰晶多跳、打死的碎成冰爆；换掉弓增益就没了', async () => {
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
        // 凛冬（凛羽）
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
    assert(r.storm && r.storm.id === 'emberstorm' && r.storm.ws === 'emberstorm' && r.storm.proj >= 3 && r.storm.embers >= 3 && r.storm.blasts >= 1 && r.storm.hit >= 3 && r.storm.ended, '凛冬不对：' + JSON.stringify(r.storm));
    return '万矢 ' + r.volley.proj + ' 支 · 穿心 ' + r.pierce.hit + ' 个 · 满溢 ' + r.over.els + ' · 凛冬 冰晶 ' + r.storm.embers + ' 跳 / 冰爆 ' + r.storm.blasts;
  });

  await step('烬铸远程：熔芯每轮最后一发必定暴击并炸开；凛羽的冰晶连跳并灌冰霜异常值；两者都按烬铸规则（固定词缀行、R 换成专属技）；旧存档的长弓读档后变成鹰眼长弓，R 不再是箭雨', async () => {
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
        // 凛羽：冰晶连跳 + 冰霜异常
        T.lane();
        save.equip.weapon = G.rollUnique('jinyu', 30, 0.5);
        G.computeStats();
        out.mech2 = P.uMech;
        const a = T.mob('husk', 6, 0), b = T.mob('husk', 8, 2), c = T.mob('husk', 9, -2);
        const e0 = S.stats.embers || 0;
        RW.hold(10, a);
        RW.run(60);
        out.ember = { jumps: (S.stats.embers || 0) - e0, b: Math.round(b.maxHp - b.hp) + Math.round(c.maxHp - c.hp), cold: +(((b.bu && b.bu.cold) || 0) + ((c.bu && c.bu.cold) || 0)).toFixed(3), frozen: (b.freeze > 0 ? 1 : 0) + (c.freeze > 0 ? 1 : 0) };
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
    assert(r.mech2 === 'ember' && r.ember.jumps >= 1 && r.ember.b > 0 && (r.ember.cold > 0 || r.ember.frozen > 0), '凛羽的冰晶应连跳并灌冰霜异常值：' + JSON.stringify(r.ember));
    const m = r.mig;
    assert(m.base === '鹰眼长弓' && m.name === '锋锐的鹰眼长弓' && m.type === 'eagle' && m.ws === 'pierceheart' && m.rare === '渊鸣鹰眼弓/灰烬之眼' && m.flag === 2 && m.noRain, '旧长弓应换成鹰眼长弓（名字同阶、稀有名不动），R 是一矢穿心：' + JSON.stringify(m));
    // 这份旧存档的技能栏是改版前的 ['cleave', 'ember', ...]：裂石击退成无铭宝石、右键的掷焰挪到左键
    assert(m.bar === 'ember,,,' && m.slot1 === 'basic_eagle', '读进拿着长弓的旧存档：右键应接管为射击、原来右键的掷焰挪到空格：' + JSON.stringify(m));
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
      G.bindSkill(0, 'ember'); // 右键固定是武器普攻：掷焰放在左键
      G.bindSkill(2, 'meteor');
      G.bindSkill(3, 'blink');
      T.dummy(4, 0);
      G.input.mouse.wx = 4;
      G.input.mouse.wz = 0;
      const out = {};
      // 魔力不足
      P.mana = 2;
      G.input.mouse.b[0] = true;
      G.debug.step(0.6);
      G.input.mouse.b[0] = false;
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
      G.input.mouse.b[0] = true;
      G.debug.step(0.4);
      G.input.mouse.b[0] = false;
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
      G.save.bar = ['blade', null, null, 'ember'];
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
      G.save.bar = ['blade', null, null, 'ember'];
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
    assert(Math.abs(r.slowK - (1 - (B.chillMin + (B.chill - B.chillMin) * Math.pow(0.7 * rc, B.chillPow)))) < 0.01, '冰霜异常值应带来轻度冰缓（保底 + 越满越慢）：' + JSON.stringify(r));
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
        const ctx = G.skillCtx('basic_blade'); // 纯物理的攻击（刃的普攻；裂石击已删除）
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

  await summonStep('冰缓看得出来：挨上一下冰就有保底减速，冻结前到上限（普通 / 精英 / 首领各有上下限）；小怪的移动、起手、预警圈和动作按同一个倍率放慢；身上泛青，冻住时换成冻结的冰色；首领的轻度冰缓、渊缚、重度冰缓取较大的', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, B = G.BUILDUP, out = {};
      // 上下限：异常值刚大于 0 / 冻结前一刻 / 空
      const nm = T.mob('husk', 4, 0), el = T.mob('husk', -4, 0, { elite: true });
      const boss = G.spawnBoss('golem', P.x, P.z - 12, 1);
      boss.hp = boss.maxHp = 1e7;
      const at = (e, c) => {
        e.bu.cold = c;
        return +G.tickBuildUp(e, 0).toFixed(4);
      };
      out.lim = {};
      for (const [k, e] of [['n', nm], ['e', el], ['b', boss]]) out.lim[k] = [at(e, 1e-4), at(e, 0.999), at(e, 0)];
      // 真实的一小下冰霜伤害（阈值的 2%）：灌进去的很少，减速照样到保底
      G.addBuildUp(nm, { cold: G.buThreshold(nm, 'cold') * 0.02 }, 0);
      out.tiny = { bu: +nm.bu.cold.toFixed(4), slow: +G.tickBuildUp(nm, 0).toFixed(4) };
      // 首领：冰缓上限 < 渊缚减速 < 重度冰缓，三者取较大的
      boss.bu.cold = 0.999;
      boss.bossBind = 1;
      out.bind = +G.tickBuildUp(boss, 0).toFixed(4);
      boss.bossChill = 1;
      out.heavy = +G.tickBuildUp(boss, 0).toFixed(4);
      G.clearEnemies();
      // 一对游魂：a 冻结前一刻的冰缓（异常值钉住不回落），b 没有冰缓。离玩家同样远、朝着玩家，同时起手
      const mk = (dx) => {
        const e = G.spawnMob('husk', P.x + dx, P.z, 1, { awake: true });
        e.wasAwake = true;
        e.hp = e.maxHp = 1e6;
        e.atkCd = 1e9;
        e.ang = Math.atan2(P.x - e.x, P.z - e.z);
        return e;
      };
      const a = mk(6), b = mk(-6);
      a.bu.cold = 0.999;
      a.buT.cold = 1e9;
      G.tick(1 / 60);
      out.k = +a.slowK.toFixed(4);
      out.kb = b.slowK;
      out.tint = [a.ent.uChill.value, b.ent.uChill.value];
      const W = G.world;
      for (const e of [a, b]) {
        e.state = 'windup';
        e.stateT = e.def.windup;
      }
      const ta = G.telegraph({ x: P.x + 30, z: P.z + 30, r: 1, dur: 5, dmg: 0, owner: a, cancelIfOwnerDead: true });
      const tb = G.telegraph({ x: P.x + 30, z: P.z - 30, r: 1, dur: 5, dmg: 0, owner: b, cancelIfOwnerDead: true });
      const w0 = [a.stateT, b.stateT];
      for (let i = 0; i < 6; i++) G.tick(1 / 60);
      out.wind = [w0[0] - a.stateT, w0[1] - b.stateT];
      out.tele = [ta.t, tb.t];
      G.cancelTelegraphs(a);
      G.cancelTelegraphs(b);
      // 走路：回到原位、空闲着追玩家 0.5 秒；动作同理
      for (const [e, dx] of [[a, 6], [b, -6]]) {
        e.state = 'idle';
        e.stateT = e.vis = 0;
        e.x = P.x + dx;
        e.z = P.z;
        e.ang = Math.atan2(P.x - e.x, P.z - e.z);
        W.play(e.ent, 'windup', { dur: 3 }); // 一段拉长到 3 秒的动作：这 0.5 秒里播不完，比较两只各播到了哪
      }
      const p0 = [a.x, b.x], c0 = [a.ent.cT, b.ent.cT];
      for (let i = 0; i < 30; i++) G.tick(1 / 60);
      out.walk = [Math.abs(a.x - p0[0]), Math.abs(b.x - p0[1])];
      out.anim = [a.ent.cT - c0[0], b.ent.cT - c0[1], W.clipOf(a.ent), W.clipOf(b.ent)];
      // 冻住：冰缓的偏色让给冻结的冰色
      a.freeze = 1;
      G.tick(1 / 60);
      out.frozen = { tint: a.ent.uChill.value, iced: !!a.ent.iced };
      return out;
    });
    const B = await ev(() => G.BUILDUP);
    const near = (x, y, t) => Math.abs(x - y) <= (t || 0.005);
    const L = r.lim;
    assert(B.chillMin >= 0.15 && B.chillMin <= 0.2 && B.chill >= 0.45 && B.chill <= 0.5, '普通敌人的冰缓应是保底 15～20%、上限 45～50%：' + JSON.stringify(B));
    assert(near(L.n[0], B.chillMin) && near(L.n[1], B.chill) && L.n[2] === 0, '普通敌人冰缓的保底 / 上限不对：' + JSON.stringify(L));
    assert(near(L.e[0], B.chillMinElite) && near(L.e[1], B.chillElite) && L.e[2] === 0 && B.chillElite < B.chill, '精英冰缓的保底 / 上限不对：' + JSON.stringify(L));
    assert(near(L.b[0], B.chillMinBoss) && near(L.b[1], B.chillBoss) && L.b[2] === 0 && B.chillBoss < B.chillElite && B.chillBoss < B.bossBindSlow, '首领冰缓的保底 / 上限不对：' + JSON.stringify(L));
    assert(r.tiny.bu > 0 && r.tiny.bu < 0.05 && r.tiny.slow >= B.chillMin, '一小下冰霜伤害就该有保底的冰缓：' + JSON.stringify(r.tiny));
    assert(near(r.bind, B.bossBindSlow) && near(r.heavy, B.bossSlow), '首领的冰缓 / 渊缚 / 重度冰缓应取较大的：' + JSON.stringify(r));
    const k = r.k;
    assert(near(k, 1 - B.chill, 0.01) && r.kb === 1, '冻结前一刻的游魂应慢到上限：' + JSON.stringify(r));
    assert(near(r.wind[0] / r.wind[1], k, 0.03) && near(r.anim[0] / r.anim[1], k, 0.03) && near(r.tele[0] / r.tele[1], k, 0.03), '起手计时、动作、预警圈应按同一个倍率放慢：' + JSON.stringify(r));
    assert(r.walk[1] > 1 && near(r.walk[0] / r.walk[1], k, 0.06), '走路应按同一个倍率放慢：' + JSON.stringify(r));
    assert(r.tint[0] > 0.9 && r.tint[1] === 0 && r.frozen.tint === 0 && r.frozen.iced, '冰缓应让身上泛青（冻住时换成冻结的冰色）：' + JSON.stringify(r));
    return '保底 / 上限 普通 ' + L.n[0] + '/' + L.n[1] + ' 精英 ' + L.e[0] + '/' + L.e[1] + ' 首领 ' + L.b[0] + '/' + L.b[1] + '；放慢倍率 ' + k + '（起手 ' + (r.wind[0] / r.wind[1]).toFixed(3) + '、动作 ' + (r.anim[0] / r.anim[1]).toFixed(3) + '、走路 ' + (r.walk[0] / r.walk[1]).toFixed(3) + '）';
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
      out.melee = one('basic_blade'); // 近战的主力：刃的右键连招「挥斩」（裂石击已删除）
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
    assert(b.avg > (r.melee.avg / 1.3) * 2.5, '闪袭每次的伤害应明显高于挥斩的一刀：' + JSON.stringify(r));
    assert(m.dps < r.ember.dps && m.dps < r.arc.dps && b.dps < r.melee.dps, '单独按冷却循环施放不应打过主力技能：' + JSON.stringify(r));
    // 穿插的收益：每个冷却周期多出一次大伤害，少放（施放时间 ÷ 主力出手间隔）下主力技能
    const gain = (cd, main) => (cd.avg / cd.cd - main.dps * (cd.cd > 0 ? (cd.id === 'blink' ? 0.2 : 0.6) / cd.cd : 0)) / main.dps;
    const gm = gain(m, r.ember), gb = gain(Object.assign({ id: 'blink' }, b), r.melee);
    // 陨火冷却 5 秒（用户定的）：每次伤害高、冷却也不长，穿插收益比闪袭大
    // 闪袭的参照从裂石击换成刃的右键连招「挥斩」（裂石击已删除），上限 30% → 36%（编排者定）：闪袭是对着裂石击调的，裂石击比旋风斩高一成半；
    // 挥斩现在和旋风斩持平（旧裂石击的 0.8 倍），闪袭本身没动，对实际配旋风斩的玩家收益本来就在 0.3–0.35，只是被删掉的参照挪了位置
    assert(gm > 0.2 && gm < 0.6 && gb > 0.12 && gb < 0.36, '穿插冷却技能的秒伤收益不对（陨火 20%–60%，闪袭对挥斩 12%–36%）：' + JSON.stringify({ gm, gb }));
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

  await summonStep('召唤物只在来源还在时存在：技能从技能栏拿下 → 它的召唤物马上原地消散（不掉落、不给经验、不炸魂火、不触发同殇 / 骸爆）；上限降了多出来的也一样；换下万魂旗 → 英灵马上消散；读档 / 换区域不带回没放在栏上的；放回去照常召唤', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, save = G.save, out = {};
      const n = (k) => S.minions.filter((m) => !m.dead && (!k || m.kind === k)).length;
      const tick = (s) => { for (let i = 0; i < Math.round(s * 60); i++) G.tick(1 / 60); };
      for (const id of Object.keys(save.sockets)) save.sockets[id] = [null, null, null];
      for (const id of ['thrall', 'colossus']) if (!save.skills[id]) { save.skills[id] = 10; save.sockets[id] = [null, null, null]; }
      // 倒下才有的效果全部记下来：解散时一次都不该调用
      const calls = { soul: 0, down: 0 }, soul0 = G.soulFire, down0 = G.relicMinionDown;
      G.soulFire = (m) => { calls.soul++; return soul0(m); };
      G.relicMinionDown = (m) => { calls.down++; return down0(m); };
      const bag0 = save.bag.splice(0); // 背包腾空：换下的万魂旗要放得进去
      try {
        save.equip.weapon = G.rollUnique('wanhun', 40, 0.5); // 拿着万魂旗：倒下的召唤物会炸魂火，解散的不会
        G.computeStats();
        out.soulMech = P.uMech;
        G.bindSkill(2, 'thrall');
        G.bindSkill(3, 'colossus');
        for (let i = 0; i < 3; i++) G.summonMinion('thrall', P.x + 2, P.z - 1 + i);
        G.summonMinion('colossus', P.x - 3, P.z);
        tick(1.2);
        out.src = { on: S.minions.every((m) => G.minionSourceOn(m)), th: n('thrall'), col: n('colossus') };
        // 1. 拿下仆从：3 具当场消散，守像不受影响
        const th = S.minions.filter((m) => m.kind === 'thrall');
        const xp0 = save.xp, lv0 = save.level, loot0 = S.loot.length, sb0 = S.stats.soulBursts || 0, d0 = S.stats.minionsDismissed || 0;
        G.bindSkill(2, null);
        out.unslot = {
          th: n('thrall'), col: n('colossus'), dying: th.every((m) => m.dead && m.ent.dying && !m.ent.removed), dismissed: (S.stats.minionsDismissed || 0) - d0,
          xp: save.xp - xp0 + (save.level - lv0) * 1e6, loot: S.loot.length - loot0, soul: (S.stats.soulBursts || 0) - sb0,
        };
        tick(0.8);
        out.unslot.gone = th.every((m) => m.ent.removed);
        out.unslot.th2 = n('thrall');
        // 2. 放回去：照常召唤；镶群聚（上限 4）召满，再取下群聚 → 多出来的 1 具当场解散
        G.bindSkill(2, 'thrall');
        out.cap0 = G.skillCtx('thrall').minion.cap; // 上限受天赋 / 装备影响，按当时的算
        save.supports.indexOf('horde') < 0 && save.supports.push('horde');
        G.socketSupport('thrall', 0, 'horde');
        out.capHorde = G.skillCtx('thrall').minion.cap;
        for (let i = 0; i < out.capHorde; i++) G.summonMinion('thrall', P.x + 2, P.z - 1.5 + i * 0.8);
        tick(1.2);
        out.reslot = n('thrall');
        const sb1 = S.stats.soulBursts || 0, d1 = S.stats.minionsDismissed || 0;
        G.socketSupport('thrall', 0, null);
        out.trim = { th: n('thrall'), cap: G.skillCtx('thrall').minion.cap, dismissed: (S.stats.minionsDismissed || 0) - d1, soul: (S.stats.soulBursts || 0) - sb1 };
        // 3. 万魂降临的英灵：换下万魂旗 → 当场消散（不等 8 秒到点、不炸魂火）
        const ctx = G.skillCtx('soulhost');
        for (let i = 0; i < 3; i++) G.summonChampion('soulhost', P.x + 1.5 * i, P.z + 3, ctx, 8);
        tick(0.6);
        out.wr = { n: n('wraith'), basic: G.weaponBasic() };
        const sb2 = S.stats.soulBursts || 0;
        out.wr.unequip = G.unequip('weapon');
        out.wr.after = n('wraith');
        out.wr.thrall = n('thrall');
        out.wr.soul = (S.stats.soulBursts || 0) - sb2;
        out.wr.basic2 = G.weaponBasic();
        out.wr.banner = S.minions.filter((m) => m.skill === 'basic_banner').length; // 魂引只是一缕魂灵，不留召唤物
        out.calls = { soul: calls.soul, down: calls.down }; // 下面骸爆那一具是真倒下，不算
        // 4. 骸爆（刻式）：倒下等着拼回来时把技能拿下 → 不再拼回来
        save.equip.weapon = T.std;
        G.computeStats();
        G.clearMinions();
        const v0 = save.variants.thrall, gl0 = save.skills.thrall;
        save.skills.thrall = Math.max(gl0, G.VARIANT_LVL); // 刻式要宝石 10 级
        save.variants.thrall = 'b';
        G.applyVariants();
        const b = G.summonMinion('thrall', P.x + 2, P.z);
        tick(1);
        G.hurtMinion(b, 1e7, 'phys', { x: P.x, z: P.z });
        out.bone = { q: G.minionBones() };
        G.bindSkill(2, null);
        out.bone.q2 = G.minionBones();
        tick(4);
        out.bone.th = n('thrall');
        if (v0) save.variants.thrall = v0;
        else delete save.variants.thrall;
        save.skills.thrall = gl0;
        G.applyVariants();
        // 5. 换区域：栏上直接被改掉（不经过 bindSkill）的召唤物不跟进新区域；栏上的照常跟着
        G.clearMinions();
        save.bar[2] = 'thrall';
        G.computeStats();
        for (let i = 0; i < 2; i++) G.summonMinion('thrall', P.x + 2, P.z + i);
        G.summonMinion('colossus', P.x - 3, P.z);
        tick(1.2);
        save.bar[2] = null;
        G.enterZone(S.zoneIdx, S.tier);
        out.zone = { th: n('thrall'), col: n('colossus') };
        // 6. 读档：开着自动召唤但技能不在栏上 → 一直是 0；放回栏上 → 自动补满
        G.clearMinions();
        save.bar[3] = null;
        save.autoSummon.thrall = true;
        // 读档会让新手提示把当前（高等级）角色当成老角色：读完把存档世代还原（同「自动召唤」那一步）
        const epoch = G.saveEpoch;
        G.persist();
        G.loadSave();
        G.saveEpoch = epoch;
        G.computeStats();
        P.cds = {};
        P.mana = P.maxMana;
        tick(2.5);
        out.load = { n: n(), bar: G.save.bar.indexOf('thrall') };
        G.bindSkill(2, 'thrall');
        for (let i = 0; i < 8; i++) {
          P.mana = P.maxMana; // 只看会不会补，不看魔力够不够
          tick(0.5);
        }
        out.load.refill = n('thrall');
        out.load.cap = G.skillCtx('thrall').minion.cap; // 这时手里是标准刃：没有万魂旗的 +1，上限可能比 cap0 少 1
      } finally {
        G.save.bag = bag0;
        G.soulFire = soul0;
        G.relicMinionDown = down0;
        if (G.save.autoSummon) G.save.autoSummon.thrall = false;
      }
      return out;
    });
    assert(r.soulMech === 'soul' && r.src.on && r.src.th === 3 && r.src.col === 1, '起始：3 具仆从 + 1 尊守像、来源都在：' + JSON.stringify(r));
    assert(r.unslot.th === 0 && r.unslot.col === 1 && r.unslot.dying && r.unslot.dismissed === 3 && r.unslot.gone && r.unslot.th2 === 0, '拿下仆从：3 具当场消散，守像不受影响：' + JSON.stringify(r.unslot));
    assert(r.unslot.xp === 0 && r.unslot.loot === 0 && r.unslot.soul === 0, '解散不掉落、不给经验、不炸魂火：' + JSON.stringify(r.unslot));
    assert(r.capHorde === r.cap0 + 1 && r.reslot === r.capHorde && r.trim.th === r.cap0 && r.trim.cap === r.cap0 && r.trim.dismissed === 1 && r.trim.soul === 0, '放回去照常召唤；上限降了多出来的当场解散、不炸魂火：' + JSON.stringify(r));
    assert(r.wr.n === 3 && r.wr.basic === 'basic_banner' && r.wr.unequip && r.wr.after === 0 && r.wr.thrall === 3 && r.wr.soul === 0 && r.wr.basic2 === 'basic_fists' && r.wr.banner === 0, '换下万魂旗：英灵当场消散，魂引跟着换掉：' + JSON.stringify(r.wr));
    assert(r.bone.q === 1 && r.bone.q2 === 0 && r.bone.th === 0, '骸爆：技能拿下后不再拼回来：' + JSON.stringify(r.bone));
    assert(r.zone.th === 0 && r.zone.col === 1, '换区域：不在栏上的仆从不跟进来，栏上的守像照常跟着：' + JSON.stringify(r.zone));
    assert(r.load.n === 0 && r.load.bar < 0 && r.load.refill === r.load.cap && r.load.cap >= 3, '读档：不在栏上就没有召唤物；放回去自动补满：' + JSON.stringify(r.load));
    assert(r.calls.soul === 0 && r.calls.down === 0, '解散不应调用魂火 / 同殇：' + JSON.stringify(r.calls));
    return '解散 ' + r.unslot.dismissed + ' + 裁上限 ' + r.trim.dismissed + '；英灵 ' + r.wr.n + ' → ' + r.wr.after;
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
      G.bindSkill(0, 'ember'); // 右键固定是武器普攻：掷焰放左键
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
      G.input.tap[0] = 0.3;
      G.tick(1 / 60);
      const c1 = P.cast;
      out.started = !!c1 && c1.id === 'ember' && !c1.fired;
      G.hurtMinion(thralls()[0], 1e9, 'phys', null);
      G.input.tap[0] = 0.6; // 施法途中又按了一下：缓冲着
      const n0 = thralls().length;
      G.tick(1 / 60);
      out.summonedMidCast = thralls().length === n0 + 1;
      out.sameCast = P.cast === c1;
      out.bufKept = G.input.tap[0] > 0.5;
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
      T.slotSummon('thrall', 'colossus'); // 召唤物只在技能放在技能栏上时存在
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
        T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
        for (let i = 0; i < 3; i++) G.summonMinion('thrall', P.x + 2, P.z + i - 1);
        G.debug.step(1.5);
        out.before = S.minions.filter((m) => m.target === near).length;
        G.hitEnemy(far, G.skillCtx('basic_blade'), 1);
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
      T.slotSummon('colossus'); // 召唤物只在技能放在技能栏上时存在
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
      T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
      // 仆从定在原地（同「召唤物挡弹」）：不然它跟着玩家走开，弹丸打不打得到取决于区域的地形
      const tx = t.x, tz = t.z;
      G.spawnProjectile({ owner: 'e', x: tx, z: tz - 3, dx: 0, dz: 1, speed: 12, dmg: 25, dtype: 'phys' });
      for (let i = 0; i < 30; i++) {
        t.x = tx;
        t.z = tz;
        t.target = null;
        t.seekT = 1;
        G.tick(1 / 60);
      }
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

  await summonStep('召唤物挡弹：敌人和玩家之间站着一只仆从，射向玩家的敌弹打中仆从就消失，玩家不挨这一发（同一轮三连扇射只结算一次伤害、三发都被挡下）；落点轰炸的预警圈不受遮挡，照常落在玩家身上', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, out = {};
      P.life = P.maxLife = 1e6;
      const d = T.openDir(10); // 一路可走、没有墙的方向（敌弹从那边射过来）
      out.len = d.len;
      const at = (k) => ({ x: P.x + d.x * k, z: P.z + d.z * k });
      T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
      const t = G.summonMinion('thrall', at(3).x, at(3).z);
      G.debug.step(0.8);
      t.hp = t.maxHp = 1e6;
      let dealt = 0, hits = 0;
      const hm0 = G.hurtMinion;
      G.hurtMinion = function (m, amount) {
        if (m === t) { dealt += amount; hits++; }
        return hm0.apply(this, arguments);
      };
      // 仆从定在玩家前方 3 m（不让它走开），敌弹从 9 m 外直直射向玩家
      const pin = () => { t.x = at(3).x; t.z = at(3).z; t.target = null; t.seekT = 1; };
      const run = (n, f) => { for (let i = 0; i < n; i++) { pin(); if (f) f(); G.tick(1 / 60); } };
      try {
        pin();
        const l0 = P.life;
        const p = G.spawnProjectile({ owner: 'e', x: at(9).x, z: at(9).z, dx: -d.x, dz: -d.z, speed: 11, r: 0.35, life: 2.5, dmg: 25, dtype: 'phys' });
        let goneZ = null; // 弹丸消失时离玩家多远（沿来向）
        run(60, () => { if (goneZ === null && S.projectiles.indexOf(p) < 0) goneZ = -+((p.x - P.x) * d.x + (p.z - P.z) * d.z).toFixed(2); });
        out.single = { dealt, hits, goneZ, player: l0 - P.life, left: S.projectiles.filter((q) => q.owner === 'e').length };
        dealt = hits = 0;
        // 同一轮齐射（volley 相同）的三发：都被挡下，对仆从只结算一次
        const l1 = P.life;
        for (let i = -1; i <= 1; i++) G.spawnProjectile({ owner: 'e', x: at(9).x + d.z * i * 0.25, z: at(9).z - d.x * i * 0.25, dx: -d.x, dz: -d.z, speed: 12, r: 0.32, life: 2.3, dmg: 20, dtype: 'light', volley: 987654 });
        run(60);
        out.fan = { dealt, hits, player: l1 - P.life, left: S.projectiles.filter((q) => q.owner === 'e').length };
        // 例外：落点轰炸（首领的落石，地上的预警圈）不看召唤物，照常砸中玩家
        const l2 = P.life;
        G.telegraph({ shape: 'circle', x: at(0.5).x, z: at(0.5).z, r: 2.7, dur: 0.3, dmg: 30, dtype: 'cold', friendly: false });
        run(30);
        out.lob = { player: l2 - P.life };
        // 没有召唤物挡着：照常打中玩家
        const away = () => { t.x = P.x - d.x * 4; t.z = P.z - d.z * 4; t.target = null; t.seekT = 1; }; // 仆从挪到玩家身后
        away();
        const l3 = P.life;
        G.spawnProjectile({ owner: 'e', x: at(6).x, z: at(6).z, dx: -d.x, dz: -d.z, speed: 11, r: 0.35, life: 2.5, dmg: 25, dtype: 'phys' });
        for (let i = 0; i < 50; i++) { away(); G.tick(1 / 60); }
        out.open = { player: l3 - P.life };
      } finally {
        G.hurtMinion = hm0;
      }
      return out;
    });
    assert(r.len >= 9.5, '竞技场里找不到 10 m 开阔的方向：' + r.len);
    assert(r.single.hits === 1 && r.single.dealt === 25 && r.single.player === 0 && r.single.left === 0, '敌弹应打中挡在中间的仆从并消失，玩家不挨这一发：' + JSON.stringify(r.single));
    assert(r.single.goneZ !== null && r.single.goneZ < -1.8 && r.single.goneZ > -4.2, '敌弹应停在仆从身上（玩家前方约 3 m）：' + JSON.stringify(r.single));
    assert(r.fan.hits === 1 && r.fan.dealt === 20 && r.fan.player === 0 && r.fan.left === 0, '同一轮三连扇射应都被挡下、只结算一次：' + JSON.stringify(r.fan));
    assert(r.lob.player > 0, '落点轰炸的预警圈应照常落在玩家身上：' + JSON.stringify(r.lob));
    assert(r.open.player > 0, '没有召唤物挡着的敌弹应照常打中玩家：' + JSON.stringify(r.open));
    return '挡下停在玩家前方 ' + -r.single.goneZ + ' m';
  });

  await summonStep('召唤物寻敌：离玩家约 11 m 的敌人（离身后的召唤物 13 m 多）有召唤物去打；醒着的远程怪在 15 m 外放冷枪也会被找上；还睡着的远处怪（离玩家 14 m）不会被召唤物拉过来', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, W = G.world, out = {};
      P.life = P.maxLife = 1e6;
      G.debug.god(true);
      // 找一个 17 m 都走得通、看得见的方向
      let dir = null;
      for (let k = 0; k < 16 && !dir; k++) {
        const a = (k / 16) * Math.PI * 2, sx = Math.sin(a), sz = Math.cos(a);
        let ok = W.walkable(P.x - sx * 3, P.z - sz * 3, 0.6);
        for (let d = 0.5; d <= 17 && ok; d += 0.5) ok = W.walkable(P.x + sx * d, P.z + sz * d, 0.7) && W.shotFree(P.x + sx * d, P.z + sz * d, -0.3);
        if (ok) dir = { sx, sz };
      }
      if (!dir) return { noDir: true };
      const at = (d) => ({ x: P.x + dir.sx * d, z: P.z + dir.sz * d });
      const summon = () => {
        G.clearMinions();
        const b = at(-2.5);
        T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
        for (let i = 0; i < 2; i++) G.summonMinion('thrall', b.x, b.z);
        G.debug.step(1.0);
      };
      const watch = (e, sec) => {
        let tEng = -1;
        for (let i = 0; i < sec * 60; i++) {
          G.tick(1 / 60);
          if (tEng < 0 && S.minions.some((m) => m.target === e)) tEng = +((i + 1) / 60).toFixed(2);
        }
        return { tEng, hurt: Math.round(e.maxHp - e.hp), awake: !!e.awake };
      };
      const put = (type, d, awake) => {
        const q = at(d);
        const e = G.spawnMob(type, q.x, q.z, 1, { awake });
        if (awake) e.wasAwake = true;
        e.hp = e.maxHp = 1e6;
        e.atkCd = 1e9;
        e.speed = 0;
        return e;
      };
      summon();
      out.d11 = watch(put('husk', 11, true), 4);
      G.clearEnemies();
      summon();
      out.d15 = watch(put('spitter', 15.5, true), 5);
      G.clearEnemies();
      summon();
      const sleeper = put('husk', 14.6, false);
      out.sleep = watch(sleeper, 3);
      G.clearEnemies();
      return out;
    });
    assert(!r.noDir, '竞技场里找不到 17 m 开阔的方向');
    assert(r.d11.tEng >= 0 && r.d11.tEng < 1 && r.d11.hurt > 0, '离玩家 11 m 的敌人应很快有召唤物去打：' + JSON.stringify(r.d11));
    assert(r.d15.tEng >= 0 && r.d15.tEng < 1 && r.d15.hurt > 0, '醒着的远程怪在 15 m 外也应被召唤物找上：' + JSON.stringify(r.d15));
    assert(r.sleep.tEng < 0 && !r.sleep.awake, '还睡着的远处怪不应被召唤物拉过来：' + JSON.stringify(r.sleep));
    return '开打 11 m ' + r.d11.tEng + ' s · 15 m ' + r.d15.tEng + ' s';
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
      // 站位要固定：这个方向跟着区域布局走（每次加载随机），上面召出来的祭司则站在玩家朝准星 (3, 2) 的身后，
      // 两者夹角每次不同——怪堆正好落在祭司身后那一侧时，祭司离怪堆只有 4～5 米，不用走就开打，量到的距离就不到 5 米。
      // 所以玩家先转身面朝怪堆（站前排），两位祭司挪到玩家身后固定的两个起点，没有敌人时走 1 秒到各自的跟随点，再放怪
      [P.face, P.drawFace] = [Math.atan2(dir.x, dir.z), Math.atan2(dir.x, dir.z)];
      T.aim(cx, cz);
      S.minions.filter((m) => m.kind === 'pyre' && !m.dead).forEach((m, i) => {
        m.x = P.x - dir.x * 2.5 + dir.z * (i ? 1 : -1);
        m.z = P.z - dir.z * 2.5 - dir.x * (i ? 1 : -1);
        m.target = null;
        m.spX = m.spZ = 1e9; // 跟随点的「走不过去」计时从头算，不沿用上面召唤时留下的
        m.spT = m.stuckT = m.navT = 0;
        G.world.setEnt(m.ent, m.x, m.z, m.ang);
      });
      G.debug.step(1.0);
      const pack = [];
      for (let i = 0; i < 5; i++) {
        const e = G.spawnMob('husk', cx + ((i % 3) - 1) * 0.9, cz + (Math.floor(i / 3) - 0.5) * 0.9, 1, { awake: true });
        e.hp = e.maxHp = 1e6;
        e.freeze = 1e9;
        e.atkCd = 1e9;
        e.mass = 1e6; // 冻住的怪照样会被火弹 / 坠焰推开：推散了坠焰就砸不中 4 个（甚至凑不够 3 个改放灼链），散成什么样又跟着墙走，每次不同
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
      T.slotSummon('pyre'); // 召唤物只在技能放在技能栏上时存在
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
      G.hitEnemy(far, G.skillCtx('basic_blade'), 0.01, {});
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
      T.slotSummon('pyre'); // 召唤物只在技能放在技能栏上时存在
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
      T.slotSummon('thrall', 'colossus'); // 召唤物只在技能放在技能栏上时存在
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
      // 远处的敌人不去追：离玩家 20（量到边缘 19.45），超过醒着的敌人的追击距离（仆从 / 守像 / 英灵 17、祭司 18）和集火目标的 19
      const far = T.mob('husk', 20, 0);
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
      out.minionOnAttack = ['dominion', 'ossify', 'horde', 'frenzy'].some((s) => G.supportFits('blade', s));
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
      T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
    assert(!r.minionOnAttack, '召唤物辅助不应能镶在非召唤技能上');
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
      T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
      const hit = () => { const h = e.hp; G.hitEnemy(e, G.skillCtx('basic_blade'), 1); return h - e.hp; };
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
      T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
        // 混沌流：异常图标多了渊缚（6 个），星蚀有自己的物品图标（it-uq-xingshi，算在装备那一类里）
        want: [G.SLOTS.reduce((n, sl) => n + G.BASES[sl].reduce((m, b) => m + b.names.length, 0), 0) + (G.icons.uqIcons ? G.icons.uqIcons().length : 0), G.CUR_IDS.length, Object.keys(G.SKILLS).length, Object.keys(G.SUPPORTS).length, 6, 1].join(),
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
        out.none.deny = ws().querySelector('.s-bubble').textContent; // 气泡文字；deny 样式还在不在看墙钟，在 test:timed 里测（计时｜武器界面）
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
    assert(cards.n === 14 && cards.ws === 1, '技能卡数量不对（14 张技能卡（裂石击已删除）+ 1 张武器技卡）：' + JSON.stringify(cards));
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
    assert(mid.lit === 12 && mid.dim === 30 && mid.cap === '镶进 掷焰', '拖辅助宝石时只有带「投射物」标签的技能的槽应亮起（掷焰、飞刃、焚骨祭司、黑旋风）：' + JSON.stringify(mid));
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
    await until((want) => T.barHud() === want, bar0.map((x) => x || '').join()).catch(() => {
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
      G.bindSkill(0, 'ember'); // 右键固定是武器普攻：掷焰放左键
      G.bindSkill(2, 'meteor');
      return 0;
    });
    await frames(3);
    await ev(() => { G.player.mana = 0; });
    await holdInput(slotOf, true);
    try {
      await until(() => document.querySelectorAll('#slots .slot')[0].classList.contains('deny')).catch(() => {
        throw new Error('魔力不足时技能格没有反馈');
      });
    } finally {
      await holdInput(slotOf, false);
    }
    r = await ev(() => { const s = document.querySelectorAll('#slots .slot')[0]; const b = s.querySelector('.s-bubble').getBoundingClientRect(), bar = document.getElementById('bar').getBoundingClientRect(); return { txt: s.querySelector('.s-bubble').textContent, inBar: b.left >= bar.left && b.right <= bar.right && b.top >= bar.top && b.bottom <= bar.bottom }; });
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

  await uiStep('准星随时找得到：关面板 / 开场卡片后鼠标不动也立刻显示在鼠标处；层级压过大字提示；鼠标停一阵再动时外圈收拢提示', async () => {
    await ev(() => {
      T.arena();
      T.settle();
      G.debug.hold(false);
    });
    const ret = () =>
      ev(() => {
        const r = document.getElementById('reticle');
        return { cls: r.className, tf: r.style.transform, disp: getComputedStyle(r).display, ping: +(r.dataset.ping || 0) };
      });
    const shown = (msg) => until(() => document.getElementById('reticle').className === 'aim', null, 10000).catch(() => {
      throw new Error(msg);
    });
    await page.mouse.move(1000, 620);
    await shown('准星没有出现');
    // 面板开关一轮：鼠标移到面板上再按 Esc 关掉，鼠标不动（之前 overCanvas 停在「在面板上」，准星和系统指针一起消失）
    await page.keyboard.press('KeyI');
    await until(() => document.getElementById('reticle').className === 'off');
    await page.mouse.move(720, 450);
    let r = await ev(() => document.elementFromPoint(720, 450).tagName);
    assert(r !== 'CANVAS', '面板没有盖住 (720, 450)');
    let p0 = (await ret()).ping;
    // 收拢提示两次之间至少隔 700 ms（ui.js 的 retPing）：开头移鼠标那一下可能刚提示过，帧快的时候面板开关一轮不到 700 ms，这一下会被吞掉。先等过冷却
    await sleep(750);
    await page.keyboard.press('Escape');
    await shown('Esc 关掉面板后鼠标不动，准星没有出现');
    r = await ret();
    assert(r.tf === 'translate(720px, 450px)' && r.disp !== 'none', '关掉面板后准星不在鼠标处：' + JSON.stringify(r));
    assert(r.ping > p0, '准星重新出现时应收拢提示一下：' + JSON.stringify(r));
    // 点面板右上的「关闭」：鼠标停在原处（按钮的位置）
    await page.keyboard.press('KeyG');
    await until(() => document.getElementById('reticle').className === 'off');
    const b = await ev(() => T.rect('#panel-close'));
    const bx = Math.round(b.x), by = Math.round(b.y);
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.up();
    assert(!(await ev(() => G.ui.isOpen())), '点「关闭」没有关掉面板');
    await shown('点「关闭」后鼠标不动，准星没有出现');
    r = await ret();
    assert(r.tf === 'translate(' + bx + 'px, ' + by + 'px)', '点「关闭」后准星不在鼠标处：' + JSON.stringify(r));
    // 开场卡片：鼠标停在卡片上按回车
    await page.mouse.move(720, 450);
    await ev(() => G.ui.showIntro());
    await until(() => document.getElementById('reticle').className === 'off');
    await page.keyboard.press('Enter');
    await shown('回车关掉开场卡片后鼠标不动，准星没有出现');
    r = await ret();
    assert(r.tf === 'translate(720px, 450px)', '关掉开场卡片后准星不在鼠标处：' + JSON.stringify(r));
    // 鼠标停 2.2 秒以上再动：收拢提示一次；接着连续移动不再提示
    await sleep(2500);
    p0 = (await ret()).ping;
    await page.mouse.move(760, 430);
    await page.mouse.move(780, 420);
    r = await ret();
    assert(r.ping === p0 + 1 && r.tf === 'translate(780px, 420px)', '鼠标停了一阵再动应提示一次：' + JSON.stringify({ p0, r }));
    // 大字提示（烬铸武器）出现在画面中上部时，准星不能被它盖住
    r = await ev(() => {
      G.ui.bigToast('测试', '测试', '#ff9b3d', '');
      return { ret: +getComputedStyle(document.getElementById('reticle')).zIndex, bt: +getComputedStyle(document.getElementById('big-toast')).zIndex, toasts: +getComputedStyle(document.getElementById('toasts')).zIndex, tip: +getComputedStyle(document.getElementById('tip')).zIndex };
    });
    assert(r.ret > r.bt && r.ret > r.toasts && r.ret < r.tip, '准星的层级应高过大字提示 / 提示条、低过悬浮提示：' + JSON.stringify(r));
    await ev(() => {
      const t = document.getElementById('big-toast');
      clearTimeout(t._t1);
      clearTimeout(t._t2);
      t.classList.remove('on', 'out');
      G.debug.hold(true);
    });
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
      s.bar = ['ember', null, 'nova', null];
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
    assert(r.sock === '[null,null,null]' && r.bar === 'ember,,nova,meteor' && r.card, '学会后应开好辅助槽并自动放进技能栏的空格（右键不算空格）：' + JSON.stringify(r));
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
    r = await ev(() => ({ api: G.useBlankGem('nova'), gems: G.save.blankGems.join(), lvl: G.save.skills.nova, ups: document.querySelectorAll('.blank-up').length }));
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
      G.bindSkill(0, 'ember'); // 新角色的样子：左键掷焰，右键是刃的普攻（T.arena 换上的标准刃）
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
    // 做到了：立刻记为看过，但卡片要留到读得完为止（至少 4 秒），不会一闪而过（「1.9 秒后才换掉」看墙钟，在 test:timed 里）
    await page.keyboard.press('Space');
    await seen('dodge');
    r = await hint();
    assert(r.state === 'done' && r.cls.includes('done') && r.minShow >= 4, '做到之后应显示「做到了」：' + JSON.stringify(r));
    await until(() => G.ui.hints().current !== 'dodge');
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
    await shown('flask');
    r = await hint();
    assert(!r.tut.includes('passive') && r.txt.includes('生命药剂'), '濒死时喝药的提示应立刻顶掉正在显示的面板提示：' + JSON.stringify(r)); // 「5 秒内」看墙钟，在 test:timed 里
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

  await step('按住 Alt 查看详情：只有带详情的技能卡 / 浮窗才有提示行；面板开着时按住 Alt 展开、松开收起', async () => {
    const keep = await ev(() => {
      const S = G.save, k = { shadestep: S.skills.shadestep, blade: S.skills.blade };
      S.skills.shadestep = Math.max(S.skills.shadestep || 0, 1);
      S.skills.blade = Math.max(S.skills.blade || 0, 1);
      return k;
    });
    try {
      const pre = await ev(() => ({ shade: !!G.SKILLS.shadestep.alt, blade: !G.SKILLS.blade.alt, relic: !!G.RELICS.qianmu.mechAlt, vb: !!G.VARIANTS.ember.b.alt, va: !G.VARIANTS.nova.a.alt }));
      assert(pre.shade && pre.blade && pre.relic && pre.vb && pre.va, '数据里的详情字段不对：' + JSON.stringify(pre));
      await page.keyboard.press('KeyG');
      await until(() => G.ui.isOpen() && document.querySelectorAll('.skill-card').length > 0);
      await panelSettled();
      const look = () => ev(() => {
        const card = (id) => Array.from(document.querySelectorAll('.skill-card')).find((n) => n.querySelector('.sk-name') && n.querySelector('.sk-name').textContent.includes(G.SKILLS[id].name));
        const sh = card('shadestep'), bl = card('blade');
        const d = sh && sh.querySelector('.alt-d'), h = sh && sh.querySelector('.alt-h');
        return { sh: !!sh, bl: !!bl, blBox: bl ? bl.querySelectorAll('.alt-box').length : -1, d: d ? (getComputedStyle(d).display !== 'none' && getComputedStyle(d).visibility === 'visible' ? 'shown' : 'hidden') : '', h: h ? getComputedStyle(h).visibility : '', hgt: sh ? Math.round(sh.getBoundingClientRect().height) : 0, ht: h ? h.textContent : '', dt: d ? d.textContent : '', alt: G.SKILLS.shadestep.alt, on: document.body.classList.contains('alt-on') };
      });
      let r = await look();
      assert(r.sh && r.bl && r.blBox === 0 && !r.on && r.d === 'hidden' && r.h === 'visible' && r.ht === '按住 Alt 查看详情' && r.dt === r.alt, '平时只显示提示行、没有详情的卡不出提示：' + JSON.stringify(r));
      const h0 = r.hgt;
      await page.keyboard.down('Alt');
      try {
        await until(() => document.body.classList.contains('alt-on'));
        r = await look();
        assert(r.d === 'shown' && r.h === 'hidden' && r.hgt === h0, '按住 Alt 应展开详情（盖在说明上，卡片高度不变）、藏起提示行：' + JSON.stringify(r) + ' 原高 ' + h0);
      } finally {
        await page.keyboard.up('Alt');
      }
      await until(() => !document.body.classList.contains('alt-on'));
      r = await look();
      assert(r.d === 'hidden' && r.h === 'visible', '松开 Alt 应收起详情：' + JSON.stringify(r));
      await closePanel();
    } finally {
      await ev((k) => {
        for (const id in k) {
          if (k[id] === undefined) delete G.save.skills[id];
          else G.save.skills[id] = k[id];
        }
      }, keep);
    }
  });

  await step('技能卡版式：1280×720 下两列等宽、不溢出列表；卡名一行、标签横排成小块；按住 Alt 时详情不盖刻式按钮，悬停的刻式浮窗不丢', async () => {
    const keep = await ev(() => {
      const S = G.save, k = { shadestep: S.skills.shadestep, blade: S.skills.blade };
      S.skills.shadestep = Math.max(S.skills.shadestep || 0, G.VARIANT_LVL);
      S.skills.blade = Math.max(S.skills.blade || 0, 1);
      return k;
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    try {
      await page.keyboard.press('KeyG');
      await until(() => G.ui.isOpen() && document.querySelectorAll('.skill-list > .skill-card').length > 2);
      await panelSettled();
      const lay = await ev(() => {
        const list = document.querySelector('.skill-list'), lr = list.getBoundingClientRect();
        return Array.from(list.querySelectorAll(':scope > .skill-card')).map((c) => {
          const nm = c.querySelector('.sk-name'), cr = c.getBoundingClientRect();
          // 单行高度：同样式的一个字
          const one = nm.cloneNode(false);
          one.textContent = '影';
          one.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
          nm.parentNode.appendChild(one);
          const lh = one.getBoundingClientRect().height;
          one.remove();
          const tags = c.querySelector('.sk-tags'), chips = tags ? Array.from(tags.children) : [];
          const tops = new Set(chips.map((t) => Math.round(t.getBoundingClientRect().top)));
          return { n: nm.firstChild.textContent, w: Math.round(cr.width), out: cr.right > lr.right - 6 + 1 || cr.left < lr.left - 1, ox: c.scrollWidth > c.clientWidth + 1, nameH: Math.round(nm.getBoundingClientRect().height), lh: Math.round(lh), chips: chips.length, rows: tops.size, dir: tags ? getComputedStyle(tags).flexDirection : '' };
        });
      });
      const ws = lay.map((c) => c.w).filter((w) => w < 500);
      assert(lay.length > 2 && lay.every((c) => !c.out && !c.ox), '技能卡不应溢出列表、卡内也不应横向溢出：' + JSON.stringify(lay));
      assert(ws.length > 1 && Math.max(...ws) - Math.min(...ws) <= 1, '1280×720 下两列应等宽：' + JSON.stringify(lay));
      assert(lay.every((c) => c.nameH <= 1.5 * c.lh), '卡名应只占一行：' + JSON.stringify(lay));
      assert(lay.every((c) => c.chips < 2 || (c.dir === 'row' && c.rows <= 2 && c.rows < c.chips)), '标签应横排（最多两行）：' + JSON.stringify(lay));
      // 悬停影步连斩的刻式 B，再按住 Alt
      const card = '.skill-list > .skill-card:has([data-act="variant"][data-skill="shadestep"])';
      await page.locator(card).scrollIntoViewIfNeeded();
      await page.locator(card + ' .sv-btn[data-v="b"]').hover();
      await until(() => document.getElementById('tip').classList.contains('on'), null, 5000);
      const h0 = await ev((sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height), card);
      await page.keyboard.down('Alt');
      let r;
      try {
        await until(() => document.body.classList.contains('alt-on'));
        await frames(3);
        r = await ev((sel) => {
          const c = document.querySelector(sel), d = c.querySelector('.sk-desc .alt-d'), dr = d.getBoundingClientRect();
          const btns = Array.from(c.querySelectorAll('.sv-btn')).map((b) => {
            const br = b.getBoundingClientRect(), hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
            return { hit: !!hit && (hit === b || b.contains(hit)), over: dr.right > br.left && dr.left < br.right && dr.bottom > br.top && dr.top < br.bottom };
          });
          return { shown: getComputedStyle(d).visibility === 'visible' && dr.height > 0, btns, tip: document.getElementById('tip').classList.contains('on'), h: Math.round(c.getBoundingClientRect().height) };
        }, card);
      } finally {
        await page.keyboard.up('Alt');
      }
      assert(r.shown && r.btns.length === 3, '按住 Alt 应显示详情、卡上有 3 个刻式按钮：' + JSON.stringify(r));
      assert(r.btns.every((b) => b.hit && !b.over), '按住 Alt 时刻式按钮不应被详情盖住：' + JSON.stringify(r));
      assert(r.tip, '按住 Alt 时悬停的刻式浮窗不应消失：' + JSON.stringify(r));
      assert(r.h === h0, '按下 Alt 卡片高度不应变：' + h0 + ' → ' + r.h);
      await until(() => !document.body.classList.contains('alt-on'));
      await page.mouse.move(5, 5);
      await closePanel();
      // 技能栏五格：法杖 / 魔杖 / 近战三类武器，1024×640 和 1440×900 各量一遍。五格等宽（差 ≤ 1 像素）；
      // 文字框在格子里；格子里没有横向溢出的元素；「按键 · 用途」只占一行（高 ≤ 1.3 倍行高）
      const kinds = await ev(() => {
        window.__sbW = G.save.equip.weapon;
        const got = {};
        for (let b = 0; b < 60 && Object.keys(got).length < 3; b++) {
          G.save.equip.weapon = G.rollItem(10, 2, 'weapon', b);
          G.computeStats();
          const k = G.weaponBasic();
          if (/^basic_(staff|wand|blade)$/.test(k) && !(k in got)) got[k] = b;
        }
        G.save.equip.weapon = window.__sbW;
        G.computeStats();
        return got;
      });
      assert(['basic_staff', 'basic_wand', 'basic_blade'].every((k) => k in kinds), '找不到法杖 / 魔杖 / 近战武器的基底：' + JSON.stringify(kinds));
      const barBad = [];
      for (const [w, h] of [[1024, 640], [1440, 900]]) {
        await page.setViewportSize({ width: w, height: h });
        for (const k of ['basic_staff', 'basic_wand', 'basic_blade']) {
          await ev((b) => { G.save.equip.weapon = G.rollItem(10, 2, 'weapon', b); G.computeStats(); }, kinds[k]);
          await page.keyboard.press('KeyG');
          await until(() => G.ui.isOpen() && document.querySelectorAll('.barstrip > div').length === 5);
          await panelSettled();
          const m = await ev(() => Array.from(document.querySelectorAll('.barstrip > div')).map((s) => {
            const r = s.getBoundingClientRect(), t = s.querySelector('.bs-txt'), tr = t.getBoundingClientRect(), sp = t.querySelector('span');
            // 单行高度：同样式的一个字（line-height 是 normal 时中文字体的行盒比 1.2 倍字号高）
            const one = sp.cloneNode(false);
            one.textContent = '键';
            one.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
            sp.parentNode.appendChild(one);
            const lh = one.getBoundingClientRect().height;
            one.remove();
            return {
              txt: t.textContent, w: r.width, spanH: Math.round(sp.getBoundingClientRect().height), lh: Math.round(lh * 10) / 10,
              inside: tr.left >= r.left - 0.5 && tr.right <= r.right + 0.5 && tr.top >= r.top - 0.5 && tr.bottom <= r.bottom + 0.5,
              over: [s, ...s.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth && getComputedStyle(n).display !== 'inline').map((n) => n.tagName.toLowerCase() + '.' + n.className + ' ' + n.scrollWidth + '>' + n.clientWidth),
            };
          }));
          const ws = m.map((q) => q.w);
          const why = [];
          if (Math.max(...ws) - Math.min(...ws) > 1) why.push('不等宽 ' + ws.map(Math.round).join('/'));
          for (const q of m) {
            if (!q.inside) why.push(q.txt + ' 文字出了格子');
            if (q.over.length) why.push(q.txt + ' 横向溢出 ' + q.over.join(','));
            if (q.spanH > 1.3 * q.lh) why.push(q.txt + ' 按键行折成多行 ' + q.spanH + '/' + q.lh);
          }
          if (why.length) barBad.push(w + '×' + h + ' ' + k + '：' + why.join('；'));
          await closePanel();
        }
      }
      assert(!barBad.length, '技能栏格子排不下：' + barBad.join(' ｜ '));
      return lay.length + ' 张卡，宽 ' + [...new Set(lay.map((c) => c.w))].join(' / ') + '；技能栏 2 种宽度 × 3 类武器';
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
      await ev(() => {
        if (!('__sbW' in window)) return;
        G.save.equip.weapon = window.__sbW;
        delete window.__sbW;
        G.computeStats();
      });
      await ev((k) => {
        for (const id in k) {
          if (k[id] === undefined) delete G.save.skills[id];
          else G.save.skills[id] = k[id];
        }
      }, keep);
    }
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
      return { life: G.player.maxLife, pts: G.passivePoints(), inc: G.skillCtx('basic_blade').inc.phys };
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
    r = await ev(() => ({ has: G.save.passives.includes('sm1'), inc: G.skillCtx('basic_blade').inc.phys }));
    assert(r.has && r.inc === base.inc + 8, '点亮膂力后物理伤害加成没变');
    await page.click(node('sm0'), { force: true }); // 退回会断开 sm1：应被拒绝
    r = await ev(() => ({ has: G.save.passives.includes('sm0'), bad: !!document.querySelector('.tree-msg.bad') }));
    assert(r.has && r.bad, '退回会造成断连的天赋应被拒绝并提示');
    await page.click(node('sm1'), { force: true });
    r = await ev(() => ({ has: G.save.passives.includes('sm1'), inc: G.skillCtx('basic_blade').inc.phys, free: G.passivePoints().free }));
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
      G.bindSkill(0, 'ember'); // 掷焰放左键（右键是不耗魔力的武器普攻）
      const life0 = P.life, mana0 = P.mana;
      G.input.mouse.b[0] = true;
      G.debug.step(0.3);
      G.input.mouse.b[0] = false;
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
      G.bindSkill(0, 'blade');
      T.fix(0.5); // 随机装备上的附加元素伤害可能让靶子感电 / 着火，多算伤害：随机数钉死
      T.dummy(2.2, 0); // 贴脸：3 枚飞刃都会碰到它
      G.input.mouse.wx = P.x + 2.2;
      G.input.mouse.wz = P.z;
      const ctx = G.skillCtx('blade');
      const maxOne = ctx.base.phys[1] * (1 + ctx.inc.phys / 100) * ctx.moreType.phys * ctx.more * (ctx.critMulti / 100);
      G.input.tap[0] = 0.25;
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
      G.input.tap[0] = 0.25;
      G.debug.step(1.2);
      out.spread = ds.filter((e) => e.hp < e.maxHp).length;
      G.socketSupport('blade', 0, null);
      // 掷焰 + 多重 / 贯穿 / 连锁 打挤在一起的 4 只：直击加爆炸，每只每次施放最多挨一下
      G.bindSkill(0, 'ember');
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
        G.input.tap[0] = 0.25;
        G.debug.step(2);
        out.ember[sups.join('+') || 'none'] = pk.map((e) => hits.filter((h) => h === e).length);
      }
      G.hitEnemy = hitEnemy;
      G.save.sockets.ember = [null, null, null];
      G.bindSkill(0, 'blade');
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
  await uiStep('连击（刃的右键普攻「挥斩」，裂石击已删除）：三段动作、范围、伤害各不相同，终结的突刺更重、击退更远、顿帧更长；停手、翻滚或换技能后从头再来；武器普攻卡上的辅助对每一段生效；连击计数与连段指示', async () => {
    const r = await ev(() => {
      T.lane();
      G.debug.god(true);
      const P = G.player, S = G.state, W = G.world;
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.bindSkill(0, 'ember'); // 右键是 T.lane 换上的标准刃的「挥斩」
      G.computeStats();
      const out = { walk: W.walkable(P.x + 7.4, P.z, 1), x0: P.x };
      T.fix(0.5); // 不暴击、伤害取中值：三段之间只差倍率
      const A = T.mob('husk', 2.6, 0); // 正前方
      const F = T.mob('husk', 6.6, 0); // 更远：扇形够不着，只有终结的突刺（弓步前冲 + 一条直线）够得着
      const ctx = G.skillCtx('basic_blade');
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
      out.comboData = G.SKILLS.basic_blade.combo.map((c) => ({ mult: c.mult, stop: c.stop, clip: c.clip, time: c.time }));
      out.speed = ctx.speed;
      out.stopK = ctx.stopK;
      // 第 4 次出手是新一轮的第一段：现在连段应该指向第二段
      out.stepAfter = P.combo.step;
      return out;
    });
    assert(r.walk, '测试场地不够宽');
    const s = r.steps;
    assert(s.every((x) => x.fired), '按住右键没有连续打出四次：' + JSON.stringify(s));
    assert(s.map((x) => x.step).join() === '0,1,2,0', '连段顺序应为 0,1,2,0，实际 ' + s.map((x) => x.step).join());
    assert(s.map((x) => x.clip).join() === 'attack1,attack2,b_thrust,attack1', '三段应各用各的动作（第三段是突刺）：' + s.map((x) => x.clip).join());
    for (let i = 0; i < 3; i++) {
      assert(Math.abs(s[i].mult - r.comboData[i].mult) < 0.01, '第 ' + (i + 1) + ' 段伤害倍率应为 ' + r.comboData[i].mult + '，实际 ' + s[i].mult.toFixed(3));
      assert(Math.abs(s[i].stop * 1000 - r.comboData[i].stop * r.stopK) < 0.5, '第 ' + (i + 1) + ' 段顿帧应为 ' + (r.comboData[i].stop * r.stopK).toFixed(1) + ' 毫秒（基础 ' + r.comboData[i].stop + ' × 出手速度系数 ' + r.stopK.toFixed(3) + '），实际 ' + (s[i].stop * 1000).toFixed(1));
    }
    assert(s[2].mult > s[0].mult * 2 && s[2].mult > s[1].mult * 2, '终结技的伤害应明显更高');
    assert(s[2].kv > s[0].kv * 3 && s[2].kv > s[1].kv * 3 && s[0].kv > 1, '终结技的击退应远大于前两段：' + s.map((x) => x.kv.toFixed(1)).join(' / '));
    assert(s[0].dmgF === 0 && s[1].dmgF === 0 && s[2].dmgF > 0, '远处的敌人应只被第三段（突刺）打到：' + s.map((x) => x.dmgF.toFixed(0)).join(' / '));
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
      pips: document.querySelectorAll('#slots .slot.has-combo .s-combo i:not(.x)').length, lit: document.querySelectorAll('#slots .slot.has-combo .s-combo i.on').length,
      slot: document.querySelector('#slots .slot.has-combo').dataset.skill, vis: +getComputedStyle(document.getElementById('combo')).opacity > 0.3,
      box: T.rect('#combo'), w: innerWidth, h: innerHeight,
    }));
    assert(h.on && h.n === '5' && h.vis, '连击计数没有显示 5：' + JSON.stringify(h));
    assert(h.box.r <= h.w && h.box.l > h.w * 0.7 && h.box.t > 190 && h.box.b < h.h - 200, '连击计数的位置不对（应在右侧中部，不压小地图和血球）：' + JSON.stringify(h.box));
    assert(h.slot === 'basic_blade' && h.pips === 3 && h.lit === 1, '右键格上的连段指示不对：' + JSON.stringify(h));

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
      G.input.tap[0] = 0.3;
      for (let i = 0; i < 40 && !(P.cast && P.cast.id === 'ember' && P.cast.fired); i++) { T.aim(A.x, A.z); G.tick(1 / 60); }
      out.ember = !!(P.cast && P.cast.id === 'ember');
      out.afterSkill = [st2, P.combo.step];
      G.debug.step(0.6);
      // 武器普攻卡上的辅助宝石对每一段都生效：蛮力（物理 +35%）、迅捷（速度 +25%）
      T.fix(0.5);
      const dmg = (st) => { const h0 = A.hp; T.aim(A.x, A.z); P.x = A.x - 2; P.z = A.z; G.execSkill(G.skillCtx('basic_blade'), G.SKILLS.basic_blade.combo[st]); return h0 - A.hp; };
      const base = [dmg(0), dmg(1), dmg(2)];
      const dur0 = G.skillCtx('basic_blade').time;
      const unit0 = G.calcHit(G.skillCtx('basic_blade'), 1).total;
      G.socketSupport(G.BASIC_CARD, 0, 'brutal');
      G.socketSupport(G.BASIC_CARD, 1, 'haste');
      const sup = [dmg(0), dmg(1), dmg(2)];
      out.ratio = sup.map((v, i) => v / base[i]);
      out.wantRatio = G.calcHit(G.skillCtx('basic_blade'), 1).total / unit0; // 纯物理时正好 1.35；装备带元素附伤时略低
      out.durRatio = G.skillCtx('basic_blade').time / dur0;
      G.debug.step(0.3);
      const s = T.swing(A);
      out.hasteHit = P.cast ? P.cast.fireT : 0;
      out.hitData = G.SKILLS.basic_blade.combo[s.step].hit;
      out.speed = G.skillCtx('basic_blade').speed;
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
      G.bindSkill(0, 'ember'); // 右键是刃的「挥斩」连招（裂石击已删除）；左键掷焰
      G.bindSkill(2, 'arc');
      G.bindSkill(3, null);
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      T.mob('husk', 2.4, 0);
      T.settle();
    });
    await aim();
    // 1. 挥砍途中按 Q：收招一到可取消的时刻就放出链雷
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    let r = await ev(() => { for (let i = 0; i < 6; i++) G.tick(1 / 60); const c = G.player.cast; return { id: c && c.id, step: c && c.step, t: c && c.t, cancelT: c && c.cancelT, fireT: c && c.fireT }; });
    assert(r.id === 'basic_blade' && r.step === 0 && r.t < r.fireT, '点击右键没有开始第一段：' + JSON.stringify(r));
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
      P.combo.step = 2; // 直接出终结技：0.54 秒后才能接别的动作
      P.combo.id = 'basic_blade';
      G.input.tap[1] = 0.3;
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
    //    掷焰（法术，左键）途中轻点 Q 也一样
    await ev(() => { G.debug.step(1); G.player.mana = G.player.maxMana; });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'left' });
    r = await ev(() => { for (let i = 0; i < 2; i++) G.tick(1 / 60); const c = G.player.cast; return { id: c && c.id, t: c && c.t }; });
    assert(r.id === 'ember' && r.t < 0.06, '左键没有开始掷焰：' + JSON.stringify(r));
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
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    await ev(() => { for (let i = 0; i < 4; i++) G.tick(1 / 60); });
    await page.keyboard.press('KeyQ');
    r = await ev(() => ({ tap: G.input.tap[2], cast: G.player.cast && G.player.cast.id }));
    assert(r.tap > 0.2 && r.cast === 'basic_blade', '挥砍途中按 Q 应记入缓冲：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    r = await ev(() => { const P = G.player; const o = { tap: G.input.tap[2], roll: P.roll.t > 0 }; let nova = false; for (let i = 0; i < 80; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') nova = true; } o.nova = nova; return o; });
    assert(r.roll && r.tap === 0 && !r.nova, '翻滚应清掉之前缓冲的技能输入：' + JSON.stringify(r));
    // 3. 翻滚途中点攻击：滚完立刻出手
    await ev(() => { G.player.roll.cd = 0; });
    await page.keyboard.press('Space');
    await ev(() => { for (let i = 0; i < 6; i++) G.tick(1 / 60); });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    r = await ev(() => {
      const P = G.player;
      const rolling = P.roll.t > 0, cast0 = !!P.cast;
      let at = -1;
      for (let i = 0; i < 40 && at < 0; i++) { G.tick(1 / 60); if (P.cast) at = P.roll.t; }
      return { rolling, cast0, at, id: P.cast && P.cast.id };
    });
    assert(r.rolling && !r.cast0 && r.id === 'basic_blade' && r.at <= 0 && r.at > -0.04, '翻滚途中按下的攻击应在翻滚结束的那一帧放出：' + JSON.stringify(r));
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
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    r = await ev(() => { const P = G.player, e = G.state.enemies[0]; T.aim(e.x, e.z); for (let i = 0; i < 5; i++) G.tick(1 / 60); return { id: P.cast && P.cast.id, fired: P.cast && P.cast.fired, hp: e.hp }; });
    assert(r.id === 'basic_blade' && r.fired === false, '没有进入起手：' + JSON.stringify(r));
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
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    r = await ev(() => { const P = G.player, e = G.state.enemies[0]; const s = T.swing(e); for (let i = 0; i < 4; i++) G.tick(1 / 60); return { fired: P.cast && P.cast.fired, t: P.cast && P.cast.t, cancelT: P.cast && P.cast.cancelT }; });
    assert(r.fired && r.t < r.cancelT, '应处在收招阶段：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    c = await ev(() => { const P = G.player; const o = { roll: P.roll.t > 0, cast: !!P.cast }; G.debug.step(1); P.roll.cd = 0; return o; });
    assert(c.roll && !c.cast, '翻滚应取消收招：' + JSON.stringify(c));
    // 6. 缓冲的输入不会带进打开的面板
    await aim();
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
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
      G.input.tap[1] = 0.3;
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
      // 重击：战锤普攻的终结（砸地，w 2、击退 2.6）；裂石击的跃劈已删除。伤害按手里的标准刃算
      const fin = G.SKILLS.basic_hammer.combo[2];
      const smash = () => G.execSkill(G.skillCtx('basic_hammer'), fin);
      const place = (x, z) => { T.arena(); G.debug.god(true); T.tp(x, z); };
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
      out.kills = [kill('basic_blade', 0.001, 0.01), kill('ember', 0.001, 0.01), kill('nova', 0.001, 0.01), kill('arc', 0.001, 0.01), kill('basic_blade', 30, 50)];
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
          if (hit) { T.aim(A.x, A.z); G.input.mouse.b[2] = true; } // 右键：刃的「挥斩」连招
          const tm = S.time;
          G.tick(1 / 60);
          ticks++;
          if (S.time === tm) frozen++;
          if (ev.cd === undefined && !(P.cds.meteor > 0)) ev.cd = ticks;
        }
        G.input.mouse.b[2] = false;
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
      const combo = G.SKILLS.basic_blade.combo;
      const cl = G.skillCtx('basic_blade');
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
        G.hitEnemy(b, G.skillCtx('basic_blade'), 1, { poise: 30 });
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
      G.bindSkill(0, 'ember');
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
        const best = Math.max(G.avgHit(G.skillCtx('basic_blade')), G.avgHit(G.skillCtx('ember')));
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
    // 4. 贴身按近战键（右键的近战普攻）：处决而不是挥砍
    s = await setup({ dx: 2.6, god: true });
    const pt = await ev(() => { const q = T.scr(E.x, E.z); return { x: Math.round(q.x), y: Math.round(q.y) }; });
    await page.mouse.move(pt.x, pt.y);
    await frames(2);
    await page.mouse.down({ button: 'right' });
    r = await ev(() => { const P = G.player; for (let i = 0; i < 3; i++) G.tick(1 / 60); return { exec: !!P.exec, cast: !!P.cast }; });
    await page.mouse.up({ button: 'right' });
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
      G.input.tap[1] = 0.3;
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
      G.input.tap[1] = 0.3;
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

    // 2. 准星贴在身前、面前没有敌人时按住右键（近战普攻的连招）：踏步不越过准星，角色不会冲过头再原地掉头
    r = await ev(() => {
      const P = G.player;
      T.lane();
      const x0 = P.x, z0 = P.z;
      let maxX = x0, flips = 0;
      for (let i = 0; i < 240; i++) {
        T.aim(x0 + 1.2, z0);
        G.input.mouse.b[2] = true;
        G.tick(1 / 60);
        maxX = Math.max(maxX, P.x);
        if (P.cast && Math.sin(P.face) < 0.5) flips++;
      }
      G.input.mouse.b[2] = false;
      G.debug.step(1);
      // 准星放远：踏步照常
      const x1 = P.x;
      for (let i = 0; i < 100; i++) { T.aim(x1 + 8, z0); G.input.mouse.b[2] = true; G.tick(1 / 60); }
      G.input.mouse.b[2] = false;
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
          for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
          if (haste) G.socketSupport(G.BASIC_CARD, 0, 'haste'); // 右键的「挥斩」：辅助镶在武器普攻卡上
          G.computeStats();
          const e = T.mob('brute', 2.6, 0);
          e.mass = 1e6;
          const ctx = G.skillCtx('basic_blade');
          const first = T.swing(e);
          G.debug.step(1.5);
          const hp0 = e.hp;
          const secs = 24;
          for (let i = 0; i < secs * 60; i++) { T.aim(e.x, e.z); G.input.mouse.b[2] = true; G.tick(1 / 60); }
          G.input.mouse.b[2] = false;
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
    const S1 = await ev(() => G.SKILLS.basic_blade.combo[0].stop); // 第一段的顿帧（毫秒）
    assert(Math.abs(r.base.stopK - Math.min(1, Math.max(0.6, 1 / r.base.speed))) < 1e-9 && Math.abs(r.base.stop - (S1 / 1000) * r.base.stopK) < 1e-6, '不带迅捷时顿帧应只随角色自身的出手速度缩放：' + JSON.stringify(r.base));
    assert(r.haste.speed > 1.2 && Math.abs(r.haste.stopK - 1 / r.haste.speed) < 1e-6 && Math.abs(r.haste.stop - S1 / 1000 / r.haste.speed) < 1e-6, '迅捷应让顿帧按出手速度缩短：' + JSON.stringify(r.haste));
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
      // 搜索范围按镜头来：卡通风格的近镜头更低更近，小地图底下对应的点（离地 4.1）离玩家近得多（1440×900 下约 dx 8.5～10、dz -2.5 上下）
      for (let dx = 4; dx <= 22 && !best; dx += 0.5) for (let dz = -16; dz <= 2; dz += 0.5) {
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
    // 技能页：最上面的武器普攻卡（拿着刃）列出连招每一段的倍率
    await page.keyboard.press('KeyG');
    const card = await ev(() => { const n = document.querySelector('.sk-combo'); return n ? n.innerText.replace(/\s+/g, ' ') : ''; });
    assert(/第 1 段 ×0\.85/.test(card) && /终结 ×1\.85/.test(card), '武器普攻卡没有列出连击倍率：' + card);
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
        // 泄漏检查：往场景里塞一堆东西后重进，场景对象数（扣除敌人）应不变。
        // 只扣根节点真的挂在场景上的敌人：正在演死亡的敌人被 W.removeEnt 挪进 corpseRoot（不再是场景的直接子节点）却还在 S.enemies 里，
        // 原来按 S.enemies.length 扣会偶尔少算出 −1（不是泄漏）。场景里多出来的对象照样一个不漏地数出来
        const count = () => W.scene.children.length - S.enemies.filter((e) => e.ent && e.ent.group && e.ent.group.parent === W.scene).length;
        // 先把来源已经不在的召唤物解散掉（前面的步骤可能改过技能栏却没推进模拟，还没来得及刷新）：
        // 否则换区域时它们才被清走，场景对象数会少一个，和泄漏无关
        G.checkMinionSources(true);
        // 异兆是懒生成的：进区那 3 帧模拟里，起点 28 m（ENC.lazy）内的异兆可能已经醒来，world 第一次醒来时才把道具组 encGroup 挂到场景上
        // （缚匣 = 匣身 / 匣盖 / 锁链三块），拾烬客还会多一个实体。下面重进时模拟停着、不会醒，基线就比重进后多出这一组，报「多了 -1 个」。
        // 先记下醒了哪几个，再把醒来的异兆道具收掉（换区时用的同一个 W.encClear），基线和重进后一样都不含它
        out.encWoke = (S.enc || []).filter((e) => e.live).map((e) => e.kind);
        W.encClear();
        const n1 = count();
        // 诊断：泄漏数不为 0 时列出前后差了哪些场景对象（类型 | 名字 | 召唤物 / 敌人 | 子节点数 | 前两个网格）
        const desc = (o) => {
          const tag = o === P.ent.group ? 'player' : (S.minions || []).some((x) => x.ent && x.ent.group === o) ? 'minion' : S.enemies.some((e) => e.ent && e.ent.group === o) ? 'enemy' : '';
          if (tag === 'enemy') return 'enemy';
          const kids = o.children.map((c) => c.type + (c.name ? ':' + c.name : '') + (c.isMesh && c.geometry ? '/' + c.geometry.type + '/' + c.material.type : '')).slice(0, 4).join(',');
          return [o.type, o.name, tag, o.visible ? 'vis' : 'hid', o.children.length, kids, [o.position.x, o.position.z].map((v) => v.toFixed(1)).join(',')].join('|');
        };
        const snap1 = W.scene.children.map(desc);
        const en1 = snap1.filter((d) => d === 'enemy').length;
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
        if (out.leak) {
          const snap2 = W.scene.children.map(desc), left = snap2.slice();
          out.leakDiff = { kids: [snap1.length, snap2.length], enemiesInScene: [en1, snap2.filter((d) => d === 'enemy').length], gone: snap1.filter((d) => { const i = left.indexOf(d); if (i < 0) return true; left.splice(i, 1); return false; }).filter((d) => d !== 'enemy'), added: left.filter((d) => d !== 'enemy') };
        }
        G.debug.step(1.5);
        out.loose2 = S.loot.length + S.projectiles.length + S.telegraphs.length + S.timers.length + (S.portal ? 1 : 0);
        return out;
      });
      assert(!r.open, '进入区域后面板应关闭');
      assert(r.idx === zi && r.id === Z.id && r.level === Z.level && r.tier === 0 && r.last === zi, '进入的区域不对：' + JSON.stringify(r));
      assert(r.name === Z.name, 'HUD 区域名没有更新：' + r.name);
      assert(r.n >= 70 && r.elites <= 6, '怪物数量不对：' + r.n); // zones-polish：区域加长到 ×1.6，精英按面积保持密度，上限 4 → 6；zones-balance：每群 ×1.25，普通怪约 ×2，下限 20 → 70（五个区各 150 次最少 84）
      assert(r.boss === Z.boss && r.bossLv === Z.level + 3, '首领不对：' + r.boss);
      assert(r.types.every((t) => Z.mobs.includes(t)), '出现了不属于该区域的怪：' + r.types);
      assert(r.bad === 0, r.bad + ' 只怪的位置不合法');
      assert(r.at < 0.01 && r.full, '玩家应在起点且满状态');
      assert(r.loose === 0 && !r.portal, '新区域里残留了上一个区域的东西');
      assert(r.fr.mean > 5 && r.fr.colors > 40, '画面像是黑屏：' + JSON.stringify(r.fr));
      assert(r.cluttered === 13, '杂物应往场景里加 13 个对象，实际 ' + r.cluttered);
      if (r.leakDiff) console.log('     泄漏诊断：' + JSON.stringify(r.leakDiff).slice(0, 4000));
      assert(r.leak === 0, '重新进入后场景里多了 ' + r.leak + ' 个对象');
      assert(r.loose2 === 0, '换区后仍有残留的运行时对象');
      return '怪物 ' + r.n + '，精英 ' + r.elites + '，亮度 ' + r.fr.mean.toFixed(1) + (r.encWoke.length ? '，进区时已醒的异兆 ' + r.encWoke.join('/') : '');
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
        while (!b.dead && n < 50) { G.hitEnemy(b, G.skillCtx('basic_blade'), 1e5); n++; }
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
    // 渊印（D3）：层级 ≥ 1 点「进入」先弹择印面板，这里选第一张「素印」（没有任何词缀，下面的断言照旧）
    if (await ev(() => !!document.querySelector('.seal-pick'))) await page.keyboard.press('Digit1');
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
      G.hitEnemy(b, G.skillCtx('basic_blade'), 1); // 打一下
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

  await step('特效贴图库（vf-vfx）：贴图包载入、五张贴图解码完成；每个区域在高 / 低画质下施放六个旗舰技能（掷焰、陨火、链雷、霜环、黑洞、黑旋风）并渲染，特效着色器编译无报错，画出序列帧和地面瞬时痕迹', async () => {
    const r = await ev(async () => {
      const W = G.world, V = G.vfx, S = G.state, P = G.player, save = G.save;
      const out = { ok: !!(V && V.ok), bytes: V ? V.bytes() : 0, rows: [], faceMin: 9, flatMin: 9 };
      if (!V) return out;
      out.ready = await V.whenReady;
      out.mats = V.materials().length;
      const keep = { zi: S.zoneIdx, tier: S.tier, q: W.quality(), bar: save.bar.slice(), skills: Object.assign({}, save.skills), sockets: JSON.parse(JSON.stringify(save.sockets)), level: save.level };
      const IDS = ['ember', 'meteor', 'arc', 'blackhole', 'vortex'];
      try {
        for (let z = 0; z < G.ZONES.length; z++) {
          G.enterZone(z, 0);
          for (const q of ['high', 'low']) {
            W.setQuality(q);
            G.clearEnemies();
            for (const k of IDS.concat('nova')) { save.skills[k] = 10; save.sockets[k] = [null, null, null]; }
            save.level = Math.max(save.level, 20);
            save.bar = ['nova', null, null, null];
            G.computeStats();
            const row = { z: S.zone.def.id, q, fb: 0, dec: 0, aura: false };
            // 方片朝向（防 6347625 那种错）：合用网格里立着的序列帧要正对镜头，冲击环（种类 4）和地面痕迹（种类 ≥ 10）要平躺
            const quadCheck = () => {
              let mesh = null;
              W.scene.traverse((o) => { if (o.isInstancedMesh && o.material && o.material.userData && o.material.userData.vfx && o.material.polygonOffset) mesh = o; });
              if (!mesh || !mesh.count) return;
              const fx = mesh.geometry.getAttribute('aFx'), m4 = new THREE.Matrix4(), n = new THREE.Vector3(), back = new THREE.Vector3(0, 0, 1).applyQuaternion(W.camera.quaternion);
              for (let i = 0; i < mesh.count; i++) {
                mesh.getMatrixAt(i, m4);
                n.set(0, 1, 0).transformDirection(m4);
                const kind = Math.round(fx.getW(i));
                if (kind === 4 || kind >= 10) out.flatMin = Math.min(out.flatMin, n.y);
                else if (kind >= 1) out.faceMin = Math.min(out.faceMin, n.dot(back));
              }
            };
            for (const id of IDS) {
              const e = G.spawnMob('husk', P.x + 5, P.z - 1, 5, { awake: true });
              e.hp = e.maxHp = 1e6;
              e.atkCd = 1e9;
              e.speed = 0;
              G.input.mouse.wx = e.x;
              G.input.mouse.wz = e.z;
              P.mana = P.maxMana;
              P.cast = null;
              G.execSkill(G.skillCtx(id));
              for (let i = 0; i < 4; i++) { G.debug.step(0.12); W.render(); if (i === 0) quadCheck(); }
              row.fb = Math.max(row.fb, W.fxFlipLive());
              row.dec = Math.max(row.dec, W.vDecalLive());
            }
            row.aura = W.auraInfo().visible;
            out.rows.push(row);
            W.clearFx();
          }
        }
      } finally {
        G.clearEnemies();
        save.bar = keep.bar;
        save.skills = keep.skills;
        save.sockets = keep.sockets;
        save.level = keep.level;
        G.computeStats();
        W.setQuality(keep.q);
        G.enterZone(keep.zi, keep.tier);
        G.debug.god(true);
      }
      return out;
    });
    assert(r.ok && r.ready && r.bytes > 50000 && r.bytes < 400000, '特效贴图包应载入、贴图全部解码（base64 50–400 KB）：' + JSON.stringify({ ok: r.ok, ready: r.ready, bytes: r.bytes }));
    assert(r.mats >= 2, '投射物的火舌应换成特效贴图库的共用材质：' + r.mats);
    assert(r.rows.length === 10 && r.rows.every((x) => x.fb > 0 && x.dec > 0 && x.aura), '每个区域、高 / 低画质下都应画出序列帧特效、地面瞬时痕迹和霜环：' + JSON.stringify(r.rows));
    assert(r.faceMin > 0.95 && r.faceMin <= 1.0001 && r.flatMin > 0.95 && r.flatMin <= 1.0001, '立着的序列帧应正对镜头、冲击环和地面痕迹应平躺（方片法线）：' + JSON.stringify({ faceMin: r.faceMin, flatMin: r.flatMin }));
    return '贴图包 ' + Math.round(r.bytes / 1024) + ' KB，' + r.rows.length + ' 轮施放，方片朝向 ' + r.faceMin.toFixed(3) + ' / ' + r.flatMin.toFixed(3);
  });

  await step('画面：CC0 素材按区域加载后换成 PBR 地面与布景；画质高 / 中 / 低即时切换、存档，三档都能渲染', async () => {
    const r = await ev(async () => {
      const W = G.world;
      const wait = async (f, ms) => {
        const t = performance.now();
        while (!f() && performance.now() - t < ms) await new Promise((res) => setTimeout(res, 50));
        return f();
      };
      const q0 = G.save.opts.quality;
      const zones = [];
      for (let i = 0; i < G.ZONES.length; i++) {
        G.enterZone(i, 0);
        await wait(() => !W.assetsPending(), 40000);
        const g = W.gfxInfo();
        zones.push(G.ZONES[i].id + ':' + (g.hd ? 'hd' : 'proc') + (g.fires ? '+' + g.fires + '火' : ''));
      }
      G.enterZone(0, 0);
      const qs = [];
      for (const q of ['high', 'mid', 'low']) {
        W.setQuality(q);
        G.debug.step(0.1);
        W.render();
        const g = W.gfxInfo();
        qs.push(q + ':' + (g.post ? 'post' : 'direct') + (g.bloom ? '+bloom' : '') + (g.mist ? '+mist' : ''));
      }
      W.setQuality(q0);
      return { zones, qs, q0, eff: W.quality(), valid: q0 === 'auto' || G.QUALITY_IDS.indexOf(q0) >= 0 };
    });
    assert(r.valid, '存档里的画质无效：' + r.q0);
    assert(r.zones.every((z) => z.includes(':hd')), '有区域没换上 PBR 外观（素材没加载到？）：' + r.zones.join(' '));
    assert(r.qs.join() === 'high:post+bloom+mist,mid:post+bloom,low:direct', '画质档位不对：' + r.qs.join());
    // 地图页的画质按钮：点了立即生效并写进存档
    await page.keyboard.press('KeyM');
    await page.click('[data-act="quality"][data-q="mid"]');
    const u = await ev(() => ({ q: G.world.quality(), o: G.save.opts.quality, st: JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).opts.quality, on: document.querySelector('[data-act="quality"].on').dataset.q }));
    await page.click('[data-act="quality"][data-q="' + r.eff + '"]');
    await closePanel();
    assert(u.q === 'mid' && u.o === 'mid' && u.st === 'mid' && u.on === 'mid', '画质按钮没有生效或没有存档：' + JSON.stringify(u));
    const back = await ev((q0) => {
      G.save.opts.quality = q0; // 恢复成测试开始时的设置（可能是 auto）
      G.persist();
      return G.world.quality();
    }, r.q0);
    assert(back === r.eff, '画质没有恢复');
    await ev(() => {
      G.enterZone(0, 1);
      G.debug.god(true);
    });
    return r.zones.join(' ') + ' ｜ ' + r.qs.join(' ') + ' ｜ 默认 ' + r.q0 + '（' + r.eff + '）';
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
      G.socketSupport(G.BASIC_CARD, 2, 'brutal'); // 右键的武器普攻卡（裂石击已删除）
      G.bindSkill(0, 'ember');
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
    assert(r.bar === 'ember,basic_blade,nova,blink' && r.lv === '等级 ' + snap.level, 'HUD 没有按存档恢复（右键格是刃的普攻）：' + r.bar + ' ' + r.lv);
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

  await step('大区小怪（G.BALANCE）：区域刷的普通怪生命 ×0.55、经验和掉落几率按倍率打折，生成器怪群人数 ×1.25（多出来的只放轻怪）；精英、首领召唤、直接刷的怪不打折', async () => {
    const r = await ev(() => {
      const B = G.BALANCE, out = { B: JSON.parse(JSON.stringify(B)) };
      const keep = { zi: G.state.zoneIdx, tier: G.state.tier, k: B.packSize };
      // 生命：每区进一次，逐只核对
      out.bad = [];
      out.cnt = { horde: 0, elite: 0 };
      for (let z = 0; z < G.ZONES.length; z++) {
        G.enterZone(z, 0);
        for (const e of G.state.enemies) {
          if (e.isBoss) continue;
          const base = e.def.hp * G.hpScale(e.level);
          if (e.elite) {
            out.cnt.elite++;
            if (e.horde || e.maxHp !== Math.max(1, Math.round(base * 4.5))) out.bad.push('精英 ' + e.type + ' ' + e.maxHp);
          } else {
            out.cnt.horde++;
            if (!e.horde || e.maxHp !== Math.max(1, Math.round(base * B.mobHp)) || e.hordeK !== (B.zoneK[e.zone.def.id] || 1)) out.bad.push('普通 ' + e.type + ' ' + e.maxHp + ' ×' + e.hordeK);
          }
        }
      }
      // 首领召唤（pack: null, awake）和调试直接刷的怪：不带 horde，满血
      const sm = G.spawnMob('husk', G.state.zone.start.x + 3, G.state.zone.start.z, 9, { elite: false, pack: null, awake: true });
      out.summon = { horde: !!sm.horde, full: sm.maxHp === Math.round(G.MOBS.husk.hp * G.hpScale(9)) };
      // 经验：普通怪 ×mobXp，精英 ×3、首领 ×20 不变
      out.xpZone = +(G.killXp(Object.assign({}, sm, { horde: true, hordeK: 1.13 }), 9) / G.mobXp(9)).toFixed(4);
      out.xp = { horde: +(G.killXp(sm.horde ? sm : Object.assign({}, sm, { horde: true }), 9) / G.mobXp(9)).toFixed(4), plain: +(G.killXp(sm, 9) / G.mobXp(9)).toFixed(4), elite: +(G.killXp(Object.assign({}, sm, { elite: true, horde: false }), 9) / G.mobXp(9)).toFixed(4) };
      // 掉落几率：同一只怪带 / 不带 horde 各掷 N 次，比物品 / 通货 / 宝石的个数
      const N = 40000, cnt = (horde) => {
        const c = { item: 0, cur: 0, gem: 0 }, s0 = G.spawnLoot, r0 = G.rollItem, c0 = G.rollCurrency;
        G.spawnLoot = (k) => { c[k === 'item' ? 'item' : k === 'cur' ? 'cur' : 'gem']++; return null; };
        G.rollItem = () => ({ rarity: 0 });
        G.rollCurrency = () => 'dust';
        try { for (let i = 0; i < N; i++) G.dropLoot({ level: 9, x: 0, z: 0, elite: false, isBoss: false, horde }); } finally { G.spawnLoot = s0; G.rollItem = r0; G.rollCurrency = c0; }
        return c;
      };
      out.lootPlain = cnt(false);
      out.lootHorde = cnt(true);
      sm.dead = true;
      G.world.removeEnt(sm.ent);
      G.state.enemies.splice(G.state.enemies.indexOf(sm), 1);
      // 怪群人数：同样的固定布局（5 个区 × 3 个种子），packSize = 1 和设计值各刷一遍，比普通怪 + 精英的总数
      const count = (k) => {
        B.packSize = k;
        let n = 0, packs = 0, heavy = 0, extra = 0;
        for (const seed of [11, 22, 33]) for (let z = 0; z < G.ZONES.length; z++) {
          G.debug.zoneSeed(seed + z);
          G.enterZone(z, 0);
          const ids = new Set();
          for (const e of G.state.enemies) if (!e.isBoss) { n++; ids.add(e.pack); if (e.packExtra) { extra++; if (!e.elite && (e.type === 'brute' || e.type === 'charger' || e.type === 'bomber')) heavy++; } }
          packs += ids.size;
        }
        return { n, packs, heavy, extra };
      };
      try { out.size1 = count(1); out.sizeK = count(keep.k); } finally { B.packSize = keep.k; G.debug.zoneSeed(null); }
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    // 设计值（owner 默认）：生命 ×0.55、每群 ×1.25
    assert(r.B.mobHp === 0.55 && r.B.packSize === 1.25, 'G.BALANCE 的生命 / 人数倍率应是 0.55 / 1.25：' + JSON.stringify(r.B));
    assert(r.bad.length === 0 && r.cnt.horde >= 150 && r.cnt.elite >= 1, '区域刷的普通怪应带 horde、生命 ×mobHp、本区的经验 / 掉落系数，精英不打折：' + JSON.stringify({ cnt: r.cnt, bad: r.bad.slice(0, 8) }));
    assert(!r.summon.horde && r.summon.full, '召唤 / 直接刷的怪不该打折：' + JSON.stringify(r.summon));
    assert(Math.abs(r.xpZone - r.B.mobXp * 1.13) < 1e-3 && Object.values(r.B.zoneK).every((k) => k > 0.8 && k < 1.25), '经验应再乘本区系数（各区系数在 0.8–1.25 之间）：' + JSON.stringify({ xpZone: r.xpZone, zoneK: r.B.zoneK }));
    assert(Math.abs(r.xp.horde - r.B.mobXp) < 1e-9 && r.xp.plain === 1 && r.xp.elite === 3 && r.B.mobXp > 0.3 && r.B.mobXp < 1, '经验：普通怪 ×mobXp、直接刷的 ×1、精英 ×3：' + JSON.stringify(r.xp));
    // 期望个数：物品 0.14·N、通货 0.09·N；打折后的比例和倍率差 15% 以内（N = 40000 时抽样误差约 2–3%）
    const rel = (k) => r.lootHorde[k] / r.lootPlain[k] / r.B.loot[k];
    assert(r.lootPlain.item > 5000 && r.lootPlain.item < 6200 && r.lootPlain.cur > 3200 && r.lootPlain.cur < 4000, '不打折的掉落几率应和原来一样（物品 14%、通货 9%）：' + JSON.stringify(r.lootPlain));
    assert(['item', 'cur', 'gem'].every((k) => Math.abs(rel(k) - 1) < 0.15) && r.B.loot.item < 1 && r.B.loot.cur < 1 && r.B.loot.gem < 1, '普通怪的掉落几率应按 G.BALANCE.loot 打折：' + JSON.stringify({ plain: r.lootPlain, horde: r.lootHorde, loot: r.B.loot }));
    // 同样的布局：怪群数不变，怪的总数约 ×1.25（随机取整的期望正好是倍率；站位半径跟着放大，几乎都摆得下）
    const kN = r.sizeK.n / r.size1.n;
    assert(r.sizeK.packs === r.size1.packs && kN > 1.15 && kN < 1.4, '同样的布局下怪群数应不变、怪的总数约 ×1.25：' + JSON.stringify({ size1: r.size1, sizeK: r.sizeK, kN }));
    // 多出来的人手只放轻怪：packSize = 1 时没有加出来的；1.25 时加出来的约占两成，其中一只巨躯 / 陨角兽 / 爆裂虫都没有
    assert(r.size1.extra === 0 && r.sizeK.extra >= r.sizeK.n * 0.12 && r.sizeK.heavy === 0, '怪群加人时多出来的应全是轻怪：' + JSON.stringify({ size1: r.size1, sizeK: r.sizeK }));
    return '普通 ' + r.cnt.horde + ' 只 / 精英 ' + r.cnt.elite + ' 只 · 经验 ×' + r.B.mobXp + ' · 掉落 物品 ×' + rel('item').toFixed(2) + ' 通货 ×' + rel('cur').toFixed(2) + '（相对倍率）· 人数 ' + r.size1.n + ' → ' + r.sizeK.n + '（×' + kN.toFixed(2) + '）· 加出来的 ' + r.sizeK.extra + ' 只（重手 ' + r.sizeK.heavy + '）';
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

  await step('天赋盘：137 个节点（9 个基石，远程改版加了枪械 / 弓各 4 个，焚骨祭司 3 个，混沌流的噬渊 9 个），原有 117 个节点的 id / 位置 / 连线不变，全部连通；满级的点数点不满', async () => {
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
    assert(r.n === 137 && r.kinds.keystone === 9 && r.kinds.notable === 30, '天赋盘的规模不对：' + JSON.stringify(r));
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
        gems: [s.skills.ember, s.skills.thrall].join(), cleave: s.skills.cleave, blank: s.blankGems.join(), free: G.passivePoints().free,
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
    // 这份旧存档里的裂石击 20 级：退成一颗 Lv 20 的无铭技能宝石（不补成长下限，用的时候学会的技能照常补）
    assert(r.gems === '32,32' && r.cleave === undefined && r.blank.split(',').includes('20') && r.mig2 === null, '宝石应补到 42 级的成长下限 32（裂石击退成 Lv 20 无铭宝石），第二次读档不再提示：' + JSON.stringify(r));
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
        while (!b.dead && n < 50) { G.hitEnemy(b, G.skillCtx('basic_blade'), 1e6); n++; }
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
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
      G.save.bar = bar0;
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

  await step('烬铸掉落：轮回层级 ≥ 1 的五个首领各掉各的那一把（巨像 → 熔芯、第五区首领 → 凛羽），层级 0 不掉；层级 1 约 15%、层级 2 起约 25%；连续 2 次没掉第 3 次必掉，掉了清零；带光柱、名牌颜色、大字提示', async () => {
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
      // 这一次只看烬铸：首领那件渊契（真随机数下常常也掉）的大字提示会盖掉烬铸的，先关掉首领来源再放回去
      const rqBoss = G.RELIC_DROP && G.RELIC_DROP.src.boss;
      if (G.RELIC_DROP) G.RELIC_DROP.src.boss = false;
      G.dropLoot({ isBoss: true, bossKind: 'warden', level: 28, x: P.x, z: P.z - 3 });
      if (G.RELIC_DROP) G.RELIC_DROP.src.boss = rqBoss;
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
    assert(r.t1.join() === 'rongxin,sanxiang,jinduan,wanhun' + (r.t1.length > 4 ? ',jinyu' : '') && r.bow !== false, '首领与烬铸的绑定不对（巨像 → 熔芯、第五区首领 → 凛羽）：' + JSON.stringify([r.kinds, r.t1, r.bow]));
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
      const ctx = G.skillCtx('basic_blade');
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
      save.bar = ['ember', null, 'thrall', null];
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
      // 另外在落击出手时（W.triStrike，每一道落击一次，带它的元素）按元素计数：轮流落下按「出手」数断言，和怪有没有被砸中无关
      // （zones-integrate：按命中数的话，目标在落击下落的 0.24 秒里被击退 / 走开就会落空，三种里任何一种都可能少几下，雷本来就少一道，
      // 改版前的 main 上 30 遍里也有 1 遍掉到 3）
      const byCtx = new Map(), spawned = { fire: 0, cold: 0, light: 0 }, ots = G.world.triStrike;
      G.world.triStrike = function (x, z, el) {
        spawned[el] = (spawned[el] || 0) + 1;
        return ots.apply(this, arguments);
      };
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
      try { while (t < 5.5) { frame++; G.tick(1 / 60); t += 1 / 60; } } finally { G.hitEnemy = oh; G.world.triStrike = ots; }
      const seen = {};
      for (const [c, frames] of byCtx) {
        const el = Object.keys(c.base)[0];
        seen[el] = (seen[el] || 0) + frames.size;
      }
      out.pack = { hits: S.stats.stormHits, storms: S.stats.storms, freezes: S.stats.freezes, blasts: S.stats.blasts, shocks: S.stats.shocks, seen, spawned, far: far.maxHp - far.hp, cd: P.cdMax.tristorm, dmg: es.map((e) => Math.round(e.maxHp - e.hp)) };
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
    const sp = r.pack.spawned, sn = r.pack.seen;
    assert(Math.min(sp.fire, sp.cold, sp.light) >= 4 && Math.max(sp.fire, sp.cold, sp.light) - Math.min(sp.fire, sp.cold, sp.light) <= 3, '火 / 冰 / 雷应轮流落下（按出手的落击数）：' + JSON.stringify(sp));
    assert(sn.fire > 0 && sn.cold > 0 && sn.light > 0 && (sn.fire || 0) + (sn.cold || 0) + (sn.light || 0) >= 12, '三种落击都应砸中怪群，砸中的合计 ≥ 12：' + JSON.stringify({ spawned: sp, seen: sn }));
    assert(r.pack.freezes > 0 && r.pack.blasts > 0 && r.pack.shocks > 0, '怪群里应接连触发冻结 / 爆燃 / 感电：' + JSON.stringify(r.pack));
    assert(Math.abs(r.pack.cd - 12) < 1e-6, '冷却应为 12 秒：' + r.pack.cd);
    assert(r.boss.grow0 === 0 && r.boss.grow.some((g) => g > 1) && !r.boss.frozen, '风暴触发的异常应让首领阈值照常变高、首领不被冻结：' + JSON.stringify(r.boss));
    return '怪群 ' + r.pack.hits + ' 击（出手 火 ' + sp.fire + ' / 冰 ' + sp.cold + ' / 雷 ' + sp.light + '，砸中 ' + sn.fire + ' / ' + sn.cold + ' / ' + sn.light + '）· 冻结 ' + r.pack.freezes + ' 爆燃 ' + r.pack.blasts + ' 感电 ' + r.pack.shocks + ' · 首领阈值 ×' + r.boss.grow.join('/');
  });

  await step('万魂降临：6 位英灵落在准星一带（按召唤物算、吃召唤物伤害加成、不占仆从上限），8 秒后消散（化作魂火）；现有召唤物治疗到满并狂热；冷却 15 秒', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, sk = G.SKILLS.soulhost, out = {};
      const keep = { skills: Object.assign({}, G.save.skills), sockets: Object.assign({}, G.save.sockets) };
      G.save.equip.weapon = G.rollUnique('wanhun', 40, 0.5);
      G.save.skills.thrall = 30; G.save.sockets.thrall = [null, null, null];
      G.computeStats();
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
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
      G.save.bar = bar0;
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

  await step('万魂旗不带位移：按住方向键放万魂降临，施放途中人站定不动（英灵照样落在准星一带）；右键魂引不按方向键时原地不动；施放结束后方向键照常能走', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, keys = G.input.keys, out = {};
      const w0 = G.save.equip.weapon;
      try {
        G.save.equip.weapon = G.rollUnique('wanhun', 40, 0.5);
        G.computeStats();
        const e = T.mob('husk', 0, -7);
        T.aim(P.x, P.z - 6);
        P.cds.soulhost = 0;
        P.mana = P.maxMana;
        keys.KeyD = true;
        G.input.tap[4] = 0.3;
        // 从起手那一帧量起，量到收招（P.cast 不再是万魂降临）
        let x0 = null, z0 = null, n = 0, moved = 0;
        for (let i = 0; i < 90; i++) {
          G.tick(1 / 60);
          const on = !!(P.cast && P.cast.id === 'soulhost');
          if (on && x0 === null) { x0 = P.x; z0 = P.z; }
          if (on) { n++; moved = Math.max(moved, Math.hypot(P.x - x0, P.z - z0)); }
          else if (x0 !== null) break;
        }
        const cast = n >= 40;
        out.host = { cast, frames: n, moved: +moved.toFixed(3), wraiths: S.minions.filter((m) => !m.dead && m.kind === 'wraith' && Math.hypot(m.x - P.x, m.z - (P.z - 6)) < 5).length };
        for (let i = 0; i < 30; i++) G.tick(1 / 60);
        out.walk = +Math.hypot(P.x - x0, P.z - z0).toFixed(2); // 施放结束后照常走
        keys.KeyD = false;
        G.debug.step(0.2);
        // 右键魂引：不按方向键
        const x1 = P.x, z1 = P.z;
        T.aim(e.x, e.z);
        G.input.tap[1] = 0.3;
        let wisp = false;
        for (let i = 0; i < 40; i++) { G.tick(1 / 60); if (S.projectiles.some((p) => p.wisp)) wisp = true; }
        out.basic = { wisp, moved: +Math.hypot(P.x - x1, P.z - z1).toFixed(3) };
      } finally {
        keys.KeyD = false;
        G.save.equip.weapon = w0;
        G.computeStats();
        G.clearMinions();
      }
      return out;
    });
    assert(r.host.cast && r.host.moved < 0.01 && r.host.wraiths >= 5, '按住方向键放万魂降临，人应站定不动、英灵落在准星一带：' + JSON.stringify(r.host));
    assert(r.walk > 0.5, '施放结束后方向键应照常能走：' + JSON.stringify(r));
    assert(r.basic.wisp && r.basic.moved < 0.01, '右键魂引不应带位移：' + JSON.stringify(r.basic));
    return '施放中位移 ' + r.host.moved + ' m，之后走了 ' + r.walk + ' m';
  });

  await step('大字提示不互相顶掉：同一帧掉两件珍品（渊契 + 烬铸），新的占正中的大字，先到的缩成一行留在下面，两条都看得见；一下子来 5 条时下面只留 2 条，其余并成「另有 N 件珍品」；各自放完就消失', async () => {
    const vis = () =>
      ev(() => {
        const bt = document.getElementById('big-toast'), st = document.getElementById('big-toast-stack');
        const seen = (el) => !!el && getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().height > 0;
        return { main: bt ? bt.innerText.replace(/\s+/g, ' ') : '', mainOn: !!bt && bt.classList.contains('on') && seen(bt), stack: st ? st.innerText.replace(/\s+/g, ' ') : '', stackOn: seen(st), rows: st ? st.querySelectorAll('.bts-row').length : 0 };
      });
    await ev(() => {
      G.ui.bigToastReset(); // 前面步骤（首领掉落）留下的大字先收起来
      G.ui.bigToast(G.RELIC_NAME, '甲之渊契', G.RELIC_COLOR, '机制甲');
      G.ui.bigToast('烬铸武器', '乙之烬铸', G.RARITY_COLOR[3], '机制乙');
    });
    const two = await vis();
    await ev(() => {
      for (let i = 1; i <= 3; i++) G.ui.bigToast('烬铸武器', '丙之' + i, G.RARITY_COLOR[3], '');
    });
    const five = await vis();
    // 「3 秒时还在、放完就消失」看墙钟，在 test:timed 里（计时｜大字提示）
    assert(two.mainOn && /乙之烬铸/.test(two.main) && !/甲之渊契/.test(two.main), '后到的应占正中的大字：' + JSON.stringify(two));
    assert(two.stackOn && /甲之渊契/.test(two.stack) && two.rows === 1, '先到的应缩成一行留在下面：' + JSON.stringify(two));
    assert(/丙之3/.test(five.main) && five.rows === 3 && /丙之2/.test(five.stack) && /丙之1/.test(five.stack) && /另有 2 件珍品/.test(five.stack), '5 条时下面应只留 2 条、其余并成一行：' + JSON.stringify(five));
    return '两条：' + two.main + ' ｜ ' + two.stack;
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
    assert(Object.keys(r.sum.skills).join() === 'ember' && r.sum.supports.length === 0, '删除后技能没有重置（新角色只学掷焰）');
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
    assert(r.level === 1 && r.bar.join() === 'ember,,,' && r.zone === 'ash', '损坏的 JSON 应回退到新存档');
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

  // ================================================================== 混沌流（混沌伤害、黑洞 / 黑旋风 / 黑焰、渊缚、噬渊支路）
  // 放在「localStorage 不可用」那一步之前：那一步把存储整个弄坏，之后读不了存档
  await step('混沌加成：伤害提高 + 元素伤害提高（一次）+ 火 / 冰 / 雷各自的提高 + 混沌伤害提高；总额外只吃 moreChaos、不吃元素过载；召唤物只吃召唤物伤害', async () => {
    const r = await ev(() => {
      T.arena();
      const snap = T.buildSnap();
      const save = G.save, P = G.player;
      save.skills.vortex = 1;
      if (!save.skills.thrall) save.skills.thrall = 1;
      Object.assign(P.S, { incAll: 10, incElem: 20, incFire: 30, incCold: 40, incLight: 50, incChaos: 60, moreElem: 30, moreChaos: 25, minionDmg: 70 });
      const v = G.skillCtx('vortex'), e = G.skillCtx('ember'), t = G.skillCtx('thrall');
      const out = { chaos: v.inc.chaos, more: v.moreType.chaos, fire: e.inc.fire, fireMore: e.moreType.fire, mChaos: t.inc.chaos, mMore: t.moreType.chaos, hasChaos: G.TYPES.indexOf('chaos') >= 0, notElem: G.ELEMS.indexOf('chaos') < 0 };
      // 前期补偿：宝石 1 级相当于 0.95 倍、15 级起回到 0.75 倍（只乘在混沌技能上）
      const lo = G.SKILLS.vortex.dmg.chaos[0];
      out.early = [1, 8, 15, 30].map((l) => +(G.skillBase('vortex', l).chaos[0] / (lo * (1 + 0.2 * (l - 1))) * 0.75).toFixed(3));
      out.emberEarly = +(G.skillBase('ember', 1).fire[0] / G.SKILLS.ember.dmg.fire[0]).toFixed(3);
      T.buildRestore(snap);
      G.computeStats();
      return out;
    });
    assert(r.chaos === 210 && Math.abs(r.more - 1.25) < 1e-9 && r.fire === 60 && Math.abs(r.fireMore - 1.3) < 1e-9, '混沌加成不对：' + JSON.stringify(r));
    assert(r.mChaos === 70 && r.mMore === 1 && r.hasChaos && r.notElem, '召唤物 / 类型表不对：' + JSON.stringify(r));
    assert(r.early.join() === '0.95,0.9,0.75,0.75' && r.emberEarly === 1, '混沌技能的前期补偿不对：' + JSON.stringify(r));
    return '混沌 +' + r.chaos + '% × ' + r.more + '（火 +' + r.fire + '% × ' + r.fireMore + '）';
  });

  await step('黑洞：把牵引圈里的小怪往中心拽（越重拽得越慢），首领几乎拽不动；两个重叠的黑洞不叠伤害；回响镶不上', async () => {
    const r = await ev(() => {
      T.arena();
      T.fix(0.5);
      const P = G.player, save = G.save;
      save.skills.blackhole = 1;
      const d = T.openDir(12), k = Math.min(6, d.len - 4);
      const cx = P.x + d.x * k, cz = P.z + d.z * k, px = -d.z, pz = d.x;
      const husk = T.mob('husk', cx - P.x + px * 3.4, cz - P.z + pz * 3.4);
      const brute = T.mob('brute', cx - P.x - px * 3.4, cz - P.z - pz * 3.4);
      const boss = G.spawnBoss('golem', cx + d.x * 3.6, cz + d.z * 3.6, 1);
      boss.awake = boss.wasAwake = true;
      boss.hp = boss.maxHp = 1e7;
      boss.speed = 0;
      boss.busy = boss.cd = 1e9;
      for (const e of [husk, brute, boss]) e.buTh = 1e9; // 只看黑洞自己的牵引，不让渊缚掺进来
      const d0 = (e) => Math.hypot(e.x - cx, e.z - cz);
      const a = [d0(husk), d0(brute), d0(boss)];
      const b0 = [boss.x, boss.z];
      T.aim(cx, cz);
      G.execSkill(G.skillCtx('blackhole'));
      const h = G.chaosHoles()[0];
      const at = h ? Math.hypot(h.x - cx, h.z - cz) : -1;
      for (let i = 0; i < 60; i++) G.tick(1 / 60);
      const out = { at, husk: a[0] - d0(husk), brute: a[1] - d0(brute), boss: Math.hypot(boss.x - b0[0], boss.z - b0[1]), fx: G.world.holeCount() };
      // 去重：同一个靶子在一个黑洞 / 两个重叠的黑洞里各吃 1 秒
      T.arena();
      T.fix(0.5);
      const one = T.mob('husk', d.x * 5, d.z * 5);
      one.buTh = 1e9;
      T.aim(P.x + d.x * 5, P.z + d.z * 5);
      G.execSkill(G.skillCtx('blackhole'));
      for (let i = 0; i < 60; i++) G.tick(1 / 60);
      out.dmg1 = Math.round(1e6 - one.hp);
      T.arena();
      T.fix(0.5);
      const two = T.mob('husk', d.x * 5, d.z * 5);
      two.buTh = 1e9;
      T.aim(P.x + d.x * 5, P.z + d.z * 5);
      G.execSkill(G.skillCtx('blackhole'));
      G.execSkill(G.skillCtx('blackhole'));
      out.n2 = G.chaosHoles().length;
      for (let i = 0; i < 60; i++) G.tick(1 / 60);
      out.dmg2 = Math.round(1e6 - two.hp);
      out.echo = G.supportFits('blackhole', 'echo');
      out.expanse = G.supportFits('blackhole', 'expanse');
      T.unfix();
      T.arena();
      out.cleared = G.chaosHoles().length;
      return out;
    });
    assert(r.at >= 0 && r.at < 0.3 && r.fx >= 1, '黑洞应落在准星处：' + JSON.stringify(r));
    assert(r.husk >= 1.5 && r.brute > 0.4 && r.brute < r.husk && r.boss < 0.8, '牵引不对（游魂应拽得最多、巨躯次之、首领几乎不动）：' + JSON.stringify(r));
    assert(r.n2 === 2 && r.dmg1 > 0 && r.dmg2 === r.dmg1, '两个重叠的黑洞不该叠伤害：' + JSON.stringify(r));
    assert(r.echo === false && r.expanse === true && r.cleared === 0, '辅助 / 清场不对：' + JSON.stringify(r));
    return '1 秒：游魂 ' + r.husk.toFixed(2) + ' 米 · 巨躯 ' + r.brute.toFixed(2) + ' · 首领 ' + r.boss.toFixed(2) + ' · 单体 ' + r.dmg1 + '（两个黑洞 ' + r.dmg2 + '）';
  });

  await step('黑旋风：每次 3 团（多重投射 +2）；吸附时把附近的小怪拽过来、首领几乎不动；撞墙反弹不散；能飞的虚空 / 熔岩上不反弹；寿命到了就散；同一次施放对同一个敌人每 0.2 秒最多一跳、最多 3 跳；贯穿 = 不吸附直接穿过；连锁 = 松开后拐向下一个敌人', async () => {
    const r = await ev(() => {
      const P = G.player, save = G.save, W = G.world, SK = G.SKILLS.vortex;
      const snap = T.buildSnap();
      const keep = { count: SK.count, wander: SK.wander };
      const ow = W.walkable, os = W.sdAt, hadSf = Object.prototype.hasOwnProperty.call(W, 'shotFree'), osf = W.shotFree;
      const cnt = new Map(), gap = new Map(), last = new Map();
      const orig = G.hitEnemy;
      G.hitEnemy = function (e, ctx) {
        if (ctx && ctx.sk && ctx.sk.kind === 'vortex') {
          cnt.set(e, (cnt.get(e) || 0) + 1);
          if (last.has(e)) gap.set(e, Math.min(gap.has(e) ? gap.get(e) : 9, G.state.time - last.get(e)));
          last.set(e, G.state.time);
        }
        return orig.apply(this, arguments);
      };
      const st = (k) => G.state.stats[k] || 0;
      const reset = (sockets) => {
        W.walkable = ow;
        if (os) W.sdAt = os;
        if (hadSf) W.shotFree = osf;
        else delete W.shotFree;
        T.arena();
        T.fix(0.5);
        save.skills.vortex = 1;
        for (const id of ['multi', 'pierce', 'chain']) if (save.supports.indexOf(id) < 0) save.supports.push(id);
        save.sockets.vortex = sockets || [null, null, null];
        cnt.clear();
        gap.clear();
        last.clear();
      };
      const tick = (sec) => { for (let i = 0, n = Math.round(sec * 60); i < n; i++) G.tick(1 / 60); };
      const out = {};
      try {
        const d = T.openDir(12), px = -d.z, pz = d.x;
        const cast = (k) => { T.aim(P.x + d.x * (k || 10), P.z + d.z * (k || 10)); G.execSkill(G.skillCtx('vortex')); return G.chaosVortices().length; };
        const along = (v) => (v.x - out.p0.x) * d.x + (v.z - out.p0.z) * d.z;
        // 1. 数量
        reset();
        out.n = cast();
        reset(['multi', null, null]);
        out.nMulti = cast();
        // 下面只放 1 团、不摆动：路线可预期
        SK.count = 1;
        SK.wander = 0;
        // 2. 吸附：正前方 4 米一只游魂；它侧面 2 米另一只（不在漩涡路线上），另一侧 3.3 米一个首领
        reset();
        const A = T.mob('husk', d.x * 4, d.z * 4), N = T.mob('husk', d.x * 4 + px * 2, d.z * 4 + pz * 2);
        const boss = G.spawnBoss('golem', P.x + d.x * 4 - px * 3.3, P.z + d.z * 4 - pz * 3.3, 1);
        boss.awake = boss.wasAwake = true;
        boss.hp = boss.maxHp = 1e7;
        boss.speed = 0;
        boss.busy = boss.cd = 1e9;
        for (const e of [A, N, boss]) e.buTh = 1e9;
        const n0 = [N.x, N.z], b0 = [boss.x, boss.z], l0 = st('vortexLatches');
        cast(4);
        let at = -1;
        for (let i = 0; i < 60 && at < 0; i++) {
          G.tick(1 / 60);
          if (st('vortexLatches') > l0) at = i;
        }
        const v0 = G.chaosVortices()[0];
        out.latch = { at, on: v0 && v0.lat === A };
        tick(0.38);
        out.latch.n = +Math.hypot(N.x - n0[0], N.z - n0[1]).toFixed(2);
        out.latch.boss = +Math.hypot(boss.x - b0[0], boss.z - b0[1]).toFixed(2);
        out.latch.hitsA = cnt.get(A) || 0;
        // 3. 撞墙反弹：前方 5 米一堵假墙（W.walkable 和 W.sdAt 一起改，区域改版的距离场路线也走得到）
        reset();
        out.p0 = { x: P.x, z: P.z };
        const wallSd = (x, z) => Math.abs((x - out.p0.x) * d.x + (z - out.p0.z) * d.z - 5) - 0.5;
        W.walkable = function (x, z, pad) { return wallSd(x, z) >= (pad || 0) && ow.call(W, x, z, pad); };
        if (os) W.sdAt = (x, z) => Math.min(os.call(W, x, z), wallSd(x, z));
        const b1 = st('vortexBounces');
        cast();
        tick(0.6);
        const vw = G.chaosVortices()[0];
        out.wall = { alive: G.chaosVortices().length, bounces: st('vortexBounces') - b1, dot: vw ? +(Math.sin(vw.a) * d.x + Math.cos(vw.a) * d.z).toFixed(2) : null, s: vw ? +along(vw).toFixed(2) : null };
        // 4. 虚空 / 熔岩：前方 3–5 米一条「不能走、但子弹能飞」的地带（stub 一个 W.shotFree）；没有 shotFree 时同一条地带会反弹
        const strip = () => {
          reset();
          out.p0 = { x: P.x, z: P.z };
          W.walkable = function (x, z, pad) { return !(Math.abs((x - out.p0.x) * d.x + (z - out.p0.z) * d.z - 4) < 1) && ow.call(W, x, z, pad); };
        };
        strip();
        W.shotFree = function (x, z, pad) { return Math.abs((x - out.p0.x) * d.x + (z - out.p0.z) * d.z - 4) < 1 ? true : W.walkable(x, z, pad); };
        const b2 = st('vortexBounces');
        cast();
        tick(0.6);
        const vv = G.chaosVortices()[0];
        out.void = { alive: G.chaosVortices().length, bounces: st('vortexBounces') - b2, s: vv ? +along(vv).toFixed(2) : null };
        strip();
        if (hadSf) W.shotFree = undefined; // 旧接口：只有 W.walkable
        const b3 = st('vortexBounces');
        cast();
        tick(0.6);
        out.void.legacyBounces = st('vortexBounces') - b3;
        // 5. 寿命：四面都能飞，1 秒时还在，2.3 秒时散了
        reset();
        W.walkable = () => true;
        if (hadSf) W.shotFree = () => true;
        cast();
        tick(1);
        out.life = [G.chaosVortices().length];
        tick(1.3);
        out.life.push(G.chaosVortices().length);
        // 6. 上限：多重投射 5 团同时绞 3 米外的一只靶子
        SK.count = keep.count;
        reset(['multi', null, null]);
        const one = T.mob('husk', d.x * 3, d.z * 3);
        one.buTh = 1e9;
        cast(3);
        tick(2.5);
        out.cap = { hits: cnt.get(one) || 0, gap: gap.has(one) ? +gap.get(one).toFixed(3) : null };
        SK.count = 1;
        // 7. 贯穿：不吸附，照样挨跳
        reset(['pierce', null, null]);
        const pe = T.mob('husk', d.x * 4, d.z * 4);
        pe.buTh = 1e9;
        const l7 = st('vortexLatches');
        cast(4);
        tick(1);
        out.pierce = { latches: st('vortexLatches') - l7, hits: cnt.get(pe) || 0, fits: G.supportFits('vortex', 'pierce') };
        // 8. 连锁：A 正前方 4 米，B 在 A 侧面 4 米；镶连锁时松开 A 之后拐向 B
        const chainRun = (sockets) => {
          reset(sockets);
          const a = T.mob('husk', d.x * 4, d.z * 4), b = T.mob('husk', d.x * 4 + px * 4, d.z * 4 + pz * 4);
          a.buTh = b.buTh = 1e9;
          cast(4);
          tick(1.5);
          return cnt.get(b) || 0;
        };
        const h8 = st('vortexHops');
        out.chain = { b: chainRun(['chain', null, null]), hops: st('vortexHops') - h8, noChain: chainRun(null), fits: G.supportFits('vortex', 'chain') };
      } finally {
        W.walkable = ow;
        if (os) W.sdAt = os;
        if (hadSf) W.shotFree = osf;
        else delete W.shotFree;
        SK.count = keep.count;
        SK.wander = keep.wander;
        G.hitEnemy = orig;
        T.unfix();
        T.arena();
        T.buildRestore(snap);
      }
      out.cleared = G.chaosVortices().length;
      return out;
    });
    assert(r.n === 3 && r.nMulti === 5, '每次应放 3 团、多重投射 5 团：' + JSON.stringify(r));
    assert(r.latch.at >= 0 && r.latch.on && r.latch.hitsA >= 2 && r.latch.n >= 0.6 && r.latch.boss < 0.2, '吸附应拽近旁边的小怪、首领几乎不动：' + JSON.stringify(r.latch));
    assert(r.wall.alive === 1 && r.wall.bounces >= 1 && r.wall.dot < -0.8 && r.wall.s < 4.6, '撞墙应反弹回来、不散：' + JSON.stringify(r.wall));
    assert(r.void.alive === 1 && r.void.bounces === 0 && r.void.s > 5.5 && r.void.legacyBounces >= 1, '能飞的虚空 / 熔岩上不该反弹：' + JSON.stringify(r.void));
    assert(r.life[0] === 1 && r.life[1] === 0, '寿命到了应散掉：' + JSON.stringify(r.life));
    assert(r.cap.hits >= 2 && r.cap.hits <= 3 && r.cap.gap >= 0.18, '同一次施放对同一个敌人每 0.2 秒最多一跳、最多 3 跳：' + JSON.stringify(r.cap));
    assert(r.pierce.fits === true && r.pierce.latches === 0 && r.pierce.hits >= 1, '贯穿：不吸附、照样挨跳：' + JSON.stringify(r.pierce));
    assert(r.chain.fits === true && r.chain.b > 0 && r.chain.hops >= 1 && r.chain.noChain === 0, '连锁应让漩涡松开后拐向下一个敌人：' + JSON.stringify(r.chain));
    assert(r.cleared === 0, '清场后不该留漩涡：' + JSON.stringify(r));
    return r.n + ' 团（多重 ' + r.nMulti + '）· 吸附拽近 ' + r.latch.n + ' 米（首领 ' + r.latch.boss + '）· 撞墙 ' + r.wall.bounces + ' 次 · 五团绞一只 ' + r.cap.hits + ' 跳';
  });

  await step('黑旋风的漏斗走实例缓冲：场上 1 团和 15 团时场景里的物体数一样，漏斗的实例数跟着团数走', async () => {
    const r = await ev(() => {
      const P = G.player, save = G.save, W = G.world;
      const snap = T.buildSnap();
      const objs = () => { let n = 0; W.scene.traverse(() => n++); return n; };
      const out = {};
      try {
        T.arena();
        T.fix(0.5);
        save.skills.vortex = 1;
        save.sockets.vortex = [null, null, null];
        const d = T.openDir(12);
        const cast = () => { T.aim(P.x + d.x * 10, P.z + d.z * 10); G.execSkill(G.skillCtx('vortex')); };
        const frame = () => { G.tick(1 / 60); W.update(1 / 60); };
        const SK = G.SKILLS.vortex, keep = SK.count;
        SK.count = 1;
        try { cast(); } finally { SK.count = keep; }
        frame();
        out.one = { n: G.chaosVortices().length, inst: W.projFxInfo().parts.chFunnel, objs: objs() };
        for (let i = 0; i < 5; i++) cast();
        frame();
        out.many = { n: G.chaosVortices().length, inst: W.projFxInfo().parts.chFunnel, objs: objs() };
      } finally {
        T.unfix();
        T.arena();
        T.buildRestore(snap);
      }
      out.cleared = G.chaosVortices().length;
      return out;
    });
    assert(r.one.n === 1 && r.one.inst === 1, '1 团时漏斗应只有 1 个实例：' + JSON.stringify(r));
    assert(r.many.n >= 15 && r.many.inst === r.many.n, '漏斗的实例数应等于场上的团数：' + JSON.stringify(r));
    assert(r.many.objs === r.one.objs, '多放漩涡不该往场景里加物体（漏斗、尘粒都画进实例缓冲）：' + JSON.stringify(r));
    assert(r.cleared === 0, '清场后不该留漩涡：' + JSON.stringify(r));
    return '1 团 → ' + r.many.n + ' 团：漏斗实例 ' + r.one.inst + ' → ' + r.many.inst + '，场景物体 ' + r.one.objs + ' → ' + r.many.objs;
  });

  await step('黑焰：放上技能栏保留 35% 魔力（节流后 21%）；攻击、法术、召唤物的每一击都多出 F% 的混沌伤害，和注入相加；触发出来的伤害不带；取下即失效', async () => {
    const r = await ev(() => {
      T.arena();
      T.fix(0.5);
      const P = G.player, save = G.save;
      const snap = T.buildSnap();
      save.skills.blackflame = 1;
      if (!save.skills.thrall) save.skills.thrall = 1;
      for (const id of ['frugal', 'cold', 'haste']) if (save.supports.indexOf(id) < 0) save.supports.push(id);
      for (const k of Object.keys(save.sockets)) save.sockets[k] = (save.sockets[k] || []).map((s) => (s === 'frugal' || s === 'cold' ? null : s));
      save.bar = ['ember', null, 'blackflame', null];
      G.computeStats();
      const out = { reserve: P.reservePct, F: G.flamePct() };
      save.sockets.blackflame = ['frugal', null, null];
      G.computeStats();
      out.reserveFrugal = P.reservePct;
      out.haste = G.supportFits('blackflame', 'haste');
      save.sockets.blackflame = [null, null, null];
      G.computeStats();
      const ratio = (ctx) => {
        const h = G.calcHit(ctx);
        let base = 0;
        for (const t in ctx.base) base += h.parts[t] && !(ctx.extra[t] > 0) ? h.parts[t] : 0;
        return { chaos: (h.parts.chaos || 0) / base, cold: (h.parts.cold || 0) / base };
      };
      out.attack = ratio(G.skillCtx('basic_blade')); // 攻击：右键刃的普攻（裂石击已删除）
      out.spell = ratio(G.skillCtx('ember'));
      save.sockets[G.BASIC_CARD] = ['cold', null, null];
      out.attackCold = ratio(G.skillCtx('basic_blade'));
      save.sockets[G.BASIC_CARD] = [null, null, null];
      // 召唤物真打一下：记下召唤物那一击的伤害组成
      let minion = null, proc = null;
      const oc = G.calcHit;
      G.calcHit = function (ctx, m) {
        const h = oc.apply(this, arguments);
        if (ctx.minion && !minion) minion = { chaos: h.parts.chaos || 0, phys: h.parts.phys || 0 };
        if (ctx.proc && !proc) proc = Object.keys(h.parts).join();
        return h;
      };
      const e = T.mob('husk', 2.2, 0);
      e.buTh = 1e9;
      T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
      G.summonMinion('thrall', P.x + 1, P.z, G.skillCtx('thrall'));
      for (let i = 0; i < 240 && !minion; i++) G.tick(1 / 60);
      // 爆燃（触发出来的伤害）：不带黑焰
      e.buTh = 1;
      e.buFire = 50;
      e.buFireN = 1;
      G.fillMeter(e, 'fire', 1.2);
      G.calcHit = oc;
      out.minion = minion ? minion.chaos / minion.phys : null;
      out.proc = proc;
      save.bar = ['ember', null, null, null];
      G.computeStats();
      out.off = G.flamePct();
      out.offCtx = G.skillCtx('ember').flame;
      T.unfix();
      T.buildRestore(snap);
      G.clearMinions();
      return out;
    });
    const f = r.F / 100, near = (a, b) => Math.abs(a - b) < 0.005;
    assert(r.reserve === 35 && Math.abs(r.reserveFrugal - 21) < 0.01 && r.haste === false && near(f, 0.06), '保留 / 数值 / 辅助不对：' + JSON.stringify(r));
    assert(near(r.attack.chaos, f) && near(r.spell.chaos, f) && r.minion !== null && near(r.minion, f), '攻击 / 法术 / 召唤物都应多出 F% 的混沌：' + JSON.stringify(r));
    assert(near(r.attackCold.chaos, f) && near(r.attackCold.cold, 0.3), '黑焰和注入应相加（按同一个底数）：' + JSON.stringify(r));
    assert(r.proc === 'fire' && r.off === 0 && r.offCtx === 0, '触发伤害不该带黑焰、取下应失效：' + JSON.stringify(r));
    return 'F = ' + r.F + '% · 攻击 ' + (r.attack.chaos * 100).toFixed(1) + '% · 法术 ' + (r.spell.chaos * 100).toFixed(1) + '% · 召唤物 ' + (r.minion * 100).toFixed(1) + '%';
  });

  await step('渊缚：混沌异常值满了定身并拽向怪群中心（附近有黑洞时拽向黑洞），期间不再累积；精英时间短；冻结中不拽；首领不定不拽、只减速且和冰缓取较大的', async () => {
    const r = await ev(() => {
      T.arena();
      T.fix(0.5);
      const P = G.player, save = G.save;
      const d = T.openDir(12), px = -d.z, pz = d.x;
      const at = (k, s) => [d.x * k + px * s, d.z * k + pz * s];
      const a = T.mob('husk', ...at(5, 0)), b = T.mob('husk', ...at(5, 2.4)), c = T.mob('husk', ...at(5, 4.8));
      const out = {};
      const cx = (a.x + b.x + c.x) / 3, cz = (a.z + b.z + c.z) / 3;
      const g0 = Math.hypot(c.x - cx, c.z - cz);
      G.fillMeter(c, 'chaos', 1.01);
      out.bind = +c.bindT.toFixed(2);
      out.target = Math.hypot(c.bindX - cx, c.bindZ - cz);
      G.fillMeter(c, 'chaos', 0.5);
      out.locked = c.bu.chaos;
      for (let i = 0; i < 20; i++) G.tick(1 / 60);
      out.held = c.held;
      out.closer = g0 - Math.hypot(c.x - cx, c.z - cz);
      // 冻结中不拽，解冻后接着拽
      a.freeze = 0.4;
      const f0 = [a.x, a.z];
      G.fillMeter(a, 'chaos', 1.01);
      for (let i = 0; i < 12; i++) G.tick(1 / 60);
      out.frozenMove = Math.hypot(a.x - f0[0], a.z - f0[1]);
      for (let i = 0; i < 30; i++) G.tick(1 / 60);
      out.thawMove = Math.hypot(a.x - f0[0], a.z - f0[1]);
      // 附近有黑洞：拽向黑洞中心
      save.skills.blackhole = 1;
      T.aim(P.x + d.x * 2 - px * 3, P.z + d.z * 2 - pz * 3);
      G.execSkill(G.skillCtx('blackhole'));
      const h = G.chaosHoles()[0];
      const e2 = T.mob('husk', ...at(6, -6));
      G.fillMeter(e2, 'chaos', 1.01);
      out.toHole = Math.hypot(e2.bindX - h.x, e2.bindZ - h.z);
      // 精英
      const el = T.mob('husk', ...at(8, 0), { elite: true });
      G.fillMeter(el, 'chaos', 1.01);
      out.elite = +el.bindT.toFixed(2);
      // 首领
      const boss = G.spawnBoss('golem', P.x - d.x * 6, P.z - d.z * 6, 1);
      boss.awake = boss.wasAwake = true;
      boss.hp = boss.maxHp = 1e7;
      boss.busy = boss.cd = 1e9;
      const b0 = [boss.x, boss.z];
      G.fillMeter(boss, 'chaos', 1.01);
      out.boss = { bind: boss.bindT, bossBind: boss.bossBind, slow: G.tickBuildUp(boss, 0), grow: boss.buGrow.chaos };
      boss.bossChill = 1;
      out.boss.slowChill = G.tickBuildUp(boss, 0);
      for (let i = 0; i < 30; i++) G.tick(1 / 60);
      out.boss.moved = Math.hypot(boss.x - b0[0], boss.z - b0[1]);
      out.binds = G.state.stats.binds || 0;
      // 飘字节流：一小堆怪同时渊缚只冒一个「渊缚」，精英照常冒
      G.debug.step(1.2);
      let tags = 0;
      const ot = G.world.text;
      G.world.text = function (x, z, str) {
        if (str === '渊缚') tags++;
        return ot.apply(this, arguments);
      };
      const heap = [0, 1, 2, 3].map((i) => T.mob('husk', ...at(-3, i * 1.1)));
      for (const e of heap) G.fillMeter(e, 'chaos', 1.01);
      out.heapTags = tags;
      const el2 = T.mob('husk', ...at(-3, 4.6), { elite: true });
      G.fillMeter(el2, 'chaos', 1.01);
      out.eliteTags = tags - out.heapTags;
      G.world.text = ot;
      T.unfix();
      T.arena();
      return out;
    });
    assert(r.bind === 1 && r.target < 0.01 && r.locked === 0 && r.held === true && r.closer > 0.8, '小怪的渊缚不对：' + JSON.stringify(r));
    assert(r.frozenMove < 0.05 && r.thawMove > 0.5, '冻结中不该拽、解冻后接着拽：' + JSON.stringify(r));
    assert(r.toHole < 0.01 && r.elite === 0.6, '黑洞 / 精英不对：' + JSON.stringify(r));
    assert(r.boss.bind === 0 && r.boss.bossBind === 2.5 && Math.abs(r.boss.slow - 0.4) < 1e-9 && Math.abs(r.boss.slowChill - 0.5) < 1e-9 && r.boss.grow === 1.5 && r.boss.moved < 0.3, '首领规则不对：' + JSON.stringify(r.boss));
    assert(r.heapTags === 1 && r.eliteTags === 1, '同一堆怪同时渊缚应只冒一个字（精英照常）：' + JSON.stringify(r));
    return '定身 ' + r.bind + ' 秒，拽近 ' + r.closer.toFixed(2) + ' 米 · 精英 ' + r.elite + ' 秒 · 首领减速 ' + r.boss.slow + ' · 一堆 4 只只冒 ' + r.heapTags + ' 个字';
  });

  await step('噬渊支路：从起点点进去（cm0 → cm1 → cl0 → cl1），跳点不行；旧的 129 个节点 id / 坐标 / 连线 / 属性一个没变；新节点离任何节点 ≥ 55 像素；基石的代价是最大生命', async () => {
    const r = await ev(() => {
      T.arena();
      const save = G.save, T0 = G.TREE;
      const keep = { passives: save.passives.slice(), level: save.level };
      save.level = 30;
      save.passives = ['start'];
      const out = { jump: G.allocPassive('cm3') };
      out.path = ['cm0', 'cm1', 'cl0', 'cl1'].map((id) => G.allocPassive(id));
      G.computeStats();
      out.flameEff = G.player.S.flameEff;
      const ids = Object.keys(T0).filter((id) => T0[id].arm !== 'c').sort();
      let s = '';
      for (const id of ids) { const n = T0[id]; s += id + ':' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ':' + n.links.filter((l) => T0[l].arm !== 'c').sort().join('/') + ':' + JSON.stringify(n.stats) + ';'; }
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      out.old = ids.length;
      out.hash = h;
      const cn = Object.keys(T0).filter((id) => T0[id].arm === 'c');
      out.n = cn.length;
      out.kinds = cn.map((id) => T0[id].kind).sort().join();
      let md = 1e9;
      for (const id of cn) for (const o in T0) if (o !== id) md = Math.min(md, Math.hypot(T0[id].x - T0[o].x, T0[id].y - T0[o].y));
      out.minDist = Math.round(md);
      out.key = T0.ck.stats;
      save.passives = keep.passives;
      save.level = keep.level;
      G.computeStats();
      return out;
    });
    assert(r.jump === false && r.path.every(Boolean) && r.flameEff === 25, '点天赋不对：' + JSON.stringify(r));
    assert(r.old === 129 && r.hash === 3380106782, '旧节点变了（id / 坐标 / 连线 / 属性）：' + JSON.stringify(r));
    assert(r.n === 9 && r.kinds === 'keystone,notable,notable,notable,small,small,small,small,small' && r.minDist >= 55, '噬渊的节点不对：' + JSON.stringify(r));
    assert(r.key.moreChaos === 25 && r.key.moreLife === -15, '基石「万籁俱寂」不对：' + JSON.stringify(r.key));
    return r.n + ' 个节点，最近 ' + r.minDist + ' 像素';
  });

  await step('旧存档（混沌流之前的格式）照常读：技能 / 辅助 / 天赋 / 烬铸 / 保底原样保留，新技能不在已学里，角色页没有混沌一行', async () => {
    const r = await ev(() => {
      T.arena();
      const keep = localStorage.getItem('cinder-abyss-save-v1');
      G.persist();
      const raw = JSON.parse(localStorage.getItem('cinder-abyss-save-v1'));
      // 一份老角色：秘识 + 统御的天赋、寒霜注入、三相之心在手（长杖，不占右键）、衔星巨兽的保底计了 1 次
      raw.level = 24;
      raw.skills = { cleave: 18, ember: 18, nova: 18 };
      raw.supports = ['cold', 'multi', 'frugal'];
      raw.sockets = { cleave: [null, null, null], ember: ['multi', 'cold', null], nova: ['frugal', null, null], wbasic: [null, null, null] };
      raw.bar = ['cleave', 'ember', 'nova', null];
      raw.passives = ['start', 'im0', 'im1', 'im2', 'mm0'];
      raw.uniq = { found: { jinyu: true }, best: { jinyu: 50 }, pity: { behemoth: 1 } };
      const staff = G.rollUnique('sanxiang', 30, 0.5);
      raw.equip = Object.assign({}, raw.equip, { weapon: staff });
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      G.computeStats();
      const s = G.save;
      const out = {
        skills: T.canon(s.skills), blank: s.blankGems.join(), sups: s.supports.join(), ember: (s.sockets.ember || []).join(), bar: s.bar.join(), passives: s.passives.join(),
        weapon: s.equip.weapon && s.equip.weapon.uq, pity: s.uniq.pity.behemoth || 0, found: !!s.uniq.found.jinyu, xs: !!s.uniq.found.xingshi,
        chaosLearned: ['blackhole', 'vortex', 'blackflame'].some((id) => s.skills[id]), flame: G.flamePct(),
      };
      G.ui.open('inv'); // 角色属性表在背包页
      out.sheet = /混沌伤害/.test(T.bodyText());
      G.ui.close();
      if (keep) localStorage.setItem('cinder-abyss-save-v1', keep);
      else localStorage.removeItem('cinder-abyss-save-v1');
      G.loadSave();
      G.computeStats();
      return out;
    });
    // 裂石击已删除：退成一颗 Lv 18 的无铭技能宝石；原来右键上的掷焰挪到空出来的左键，镶着的辅助跟着它
    assert(r.skills === '{"ember":18,"nova":18}' && r.blank.split(',').includes('18') && r.sups === 'cold,multi,frugal' && r.ember === 'multi,cold,' && r.bar === 'ember,,nova,', '技能数据没有原样保留：' + JSON.stringify(r));
    assert(r.passives === 'start,im0,im1,im2,mm0' && r.weapon === 'sanxiang' && r.pity === 1 && r.found && !r.xs, '天赋 / 烬铸 / 保底没有原样保留：' + JSON.stringify(r));
    assert(!r.chaosLearned && r.flame === 0 && !r.sheet, '旧存档不该凭空多出混沌：' + JSON.stringify(r));
    return '读档后原样：' + r.passives;
  });

  // ------------------------------------------------------------------ D1 刻式（设计稿 §10）
  // 五步共用：进来时把存档存一份，最后一步结束时原样放回（刻式、宝石等级、通货都不带进后面的步骤）
  let varKeep = null;
  await step('刻式：裂石击以外的 14 个宝石技能都有 A / B；宝石 9 级不能选、10 级能选；第一次免费，第二次扣 1 乱流石、不够时拒绝；战斗中拒绝；技能页 10 级才有三个按钮', async () => {
    varKeep = await ev(() => { G.persist(); return localStorage.getItem('cinder-abyss-save-v1'); });
    const r = await ev(() => {
      T.arena();
      const s = G.save, P = G.player, out = {};
      // 裂石击不做刻式（要从可学技能里拿掉，见设计稿实现记录）：其余宝石技能都要有，表里也不能有别的
      out.n = Object.keys(G.VARIANTS).length;
      out.missing = G.GEM_SKILLS.filter((id) => id !== 'cleave').filter((id) => !(G.VARIANTS[id] && G.VARIANTS[id].a && G.VARIANTS[id].b && G.VARIANTS[id].a.name && G.VARIANTS[id].b.name && G.VARIANTS[id].a.desc && G.VARIANTS[id].b.desc));
      out.extra = Object.keys(G.VARIANTS).filter((id) => G.GEM_SKILLS.indexOf(id) < 0 || id === 'cleave');
      out.price = G.VARIANT_LVL === 10 && G.VARIANT_COST.cur === 'chaos' && G.VARIANT_COST.n === 1 && G.CURRENCY.chaos.name === '乱流石';
      s.variants = {};
      s.variantFree = {};
      s.skills.ember = 9;
      s.cur.chaos = 0;
      out.lv9 = G.setVariant('ember', 'a').ok;
      // 技能页：9 级只有一行灰字，没有按钮
      G.ui.open('skills');
      out.btn9 = document.querySelectorAll('[data-act="variant"][data-skill="ember"]').length;
      out.lock9 = /宝石 Lv 10 解锁/.test(T.bodyText());
      G.ui.close();
      s.skills.ember = 10;
      const r1 = G.setVariant('ember', 'a');
      out.free = r1.ok && r1.cost === 0 && s.cur.chaos === 0 && G.SKILLS.ember.vname === '跳焰' && s.variants.ember === 'a';
      const r2 = G.setVariant('ember', 'b');
      out.refuse = !r2.ok && /乱流石/.test(r2.msg) && G.SKILLS.ember.vname === '跳焰';
      s.cur.chaos = 2;
      const r3 = G.setVariant('ember', 'b');
      out.paid = r3.ok && r3.cost === 1 && s.cur.chaos === 1 && G.SKILLS.ember.vname === '黏焰';
      // 战斗中：6 米外一只醒着的怪
      const e = T.mob('husk', 6, 0);
      const r4 = G.setVariant('ember', 'o');
      out.combat = !r4.ok && /战斗中/.test(r4.msg) && s.cur.chaos === 1 && G.SKILLS.ember.vname === '黏焰';
      e.awake = false;
      out.asleep = G.variantBusy() === false; // 睡着的怪不算
      G.clearEnemies();
      // 技能页：10 级三个按钮，当前的那个亮着；点一下（钱够）就换
      G.ui.open('skills');
      const btns = document.querySelectorAll('[data-act="variant"][data-skill="ember"]');
      out.btn10 = btns.length;
      out.on = Array.from(btns).map((b) => (b.classList.contains('on') ? b.dataset.v : '')).join('');
      btns[0].click();
      out.clicked = s.cur.chaos === 0 && !s.variants.ember && G.SKILLS.ember === G.SKILL_V.ember.o && /换成了「原式」/.test(T.bodyText());
      G.ui.close();
      return out;
    });
    assert(r.n === 14 && !r.missing.length && !r.extra.length && r.price, '刻式表不全：' + JSON.stringify(r));
    assert(!r.lv9 && r.btn9 === 0 && r.lock9, '宝石 9 级不该能选刻式：' + JSON.stringify(r));
    assert(r.free && r.refuse && r.paid, '价格不对（第一次免费、之后 1 乱流石、不够拒绝）：' + JSON.stringify(r));
    assert(r.combat && r.asleep, '战斗中应拒绝换刻式：' + JSON.stringify(r));
    assert(r.btn10 === 3 && r.on === 'b' && r.clicked, '技能页的刻式按钮不对：' + JSON.stringify(r));
    return '14 个技能 × A / B；免费 → 拒绝 → 扣 1 → 战斗中拒绝 → 按钮换回原式';
  });

  await step('刻式：没选时 G.SKILLS 和 G.SKILL_BASE 深比较完全相同（28 个刻式各选一遍再改回原式也相同，对象就是原来那个）', async () => {
    const r = await ev(() => {
      T.arena();
      const s = G.save, eq = () => T.canon(G.SKILLS) === T.canon(G.SKILL_BASE);
      const out = { start: eq() };
      const same0 = Object.keys(G.SKILL_V).every((id) => G.SKILLS[id] === G.SKILL_V[id].o);
      s.cur.chaos = 99;
      const diff = [];
      for (const id of Object.keys(G.VARIANTS)) {
        s.skills[id] = Math.max(10, s.skills[id] || 0);
        for (const v of ['a', 'b']) {
          const rr = G.setVariant(id, v);
          if (!rr.ok || G.SKILLS[id].variant !== v || T.canon(G.SKILLS[id]) === T.canon(G.SKILL_BASE[id])) diff.push(id + '.' + v);
        }
        G.setVariant(id, 'o');
      }
      out.diff = diff;
      out.back = eq();
      out.same = same0 && Object.keys(G.SKILL_V).every((id) => G.SKILLS[id] === G.SKILL_V[id].o);
      // 拼刻式不能改到原表：SKILL_BASE 和 data.js 刚读进来时一样（G.SKILL_V.o 就是原对象）
      out.base = Object.keys(G.SKILL_V).every((id) => T.canon(G.SKILL_V[id].o) === T.canon(G.SKILL_BASE[id]));
      return out;
    });
    assert(r.start && r.back && r.same && r.base, '原式和 G.SKILL_BASE 不一致：' + JSON.stringify(r));
    assert(!r.diff.length, '这些刻式没生效或和原式一样：' + r.diff.join(', '));
    return '28 个刻式选一遍再改回，G.SKILLS 深比较不变';
  });

  await step('刻式：单体对等——游戏内 avgHit / useMult / time 算出 28 个比值都在 [0.9, 1.1]（霜环、黑焰按总秒伤 [0.95, 1.05]）', async () => {
    const r = await ev(() => {
      T.arena();
      const s = G.save;
      s.level = 40;
      for (const id of G.GEM_SKILLS) {
        s.skills[id] = 30;
        s.sockets[id] = [null, null, null];
      }
      s.bar = ['ember', 'nova', null, null];
      s.variants = {};
      G.applyVariants();
      G.computeStats();
      const rows = [];
      for (const id of Object.keys(G.VARIANTS)) {
        const sk = G.SKILLS[id], total = sk.kind === 'aura';
        for (const v of ['a', 'b']) rows.push({ id, v, name: G.VARIANTS[id][v].name, total, r: +G.variantRatio(id, v).toFixed(3) });
      }
      return rows;
    });
    const bad = r.filter((x) => (x.total ? x.r < 0.95 || x.r > 1.05 : x.r < 0.9 || x.r > 1.1));
    assert(r.length === 28 && !bad.length, '比值超出范围：' + JSON.stringify(bad));
    return r.map((x) => x.name + ' ' + x.r).join(' / ');
  });

  // ---- 刻式第二版（variants-v2）：每个刻式一步，验它那条新规则真的触发了 ----
  // TVDEF：页面里的小工具（每步开头装一遍，步骤之间互不依赖）。setup(id, v)：标准场地、角色 40 级、宝石 30 级、只选这一个刻式、魔力无限、暂停主循环；
  // at(k, side)：沿开阔方向 k 米、往右偏 side 米的点；mob / boss：不动不还手的靶子；cast：朝某点放一次；run(sec)：推进模拟；
  // n(e) / dmg(e)：这一步里 watch 技能打中 e 的次数 / 伤害（hitEnemy 包一层）；hold(slot, sec)：按住技能键推进；done()：还原
  const TVDEF = () => {
    const P = G.player, s = G.save;
    window.TV = {
      setup(id, v, bar) {
        T.unfix();
        T.arena();
        G.debug.hold(true);
        s.level = 40;
        for (const k of G.GEM_SKILLS) {
          s.skills[k] = 30;
          s.sockets[k] = [null, null, null];
        }
        s.variants = {};
        if (v && v !== 'o') s.variants[id] = v;
        G.applyVariants();
        s.bar = bar || [id, null, null, null];
        for (const k in s.autoSummon) s.autoSummon[k] = false;
        G.computeStats();
        P.mana = P.maxMana = 1e6;
        P.god = true;
        TV.d = T.openDir(18);
        TV.st0 = Object.assign({}, G.state.stats);
        TV.pins = [];
        TV.watch = id;
        TV.cnt = new Map();
        TV.sum = new Map();
        if (!TV.orig) {
          TV.orig = G.hitEnemy;
          G.hitEnemy = function (e, ctx) {
            const r = TV.orig.apply(this, arguments);
            if (ctx && (ctx.id === TV.watch || (TV.watch === '*proc' && ctx.proc))) {
              TV.cnt.set(e, (TV.cnt.get(e) || 0) + 1);
              TV.sum.set(e, (TV.sum.get(e) || 0) + (r || 0));
            }
            return r;
          };
        }
        return TV.d;
      },
      at(k, side) {
        const d = TV.d;
        return { x: P.x + d.x * k + d.z * (side || 0), z: P.z + d.z * k - d.x * (side || 0) };
      },
      mob(k, side, o) {
        const p = TV.at(k, side);
        return T.mob((o && o.type) || 'husk', p.x - P.x, p.z - P.z, o);
      },
      // 统计的增量（G.state.stats 是整局累计的）
      st: (k) => (G.state.stats[k] || 0) - (TV.st0[k] || 0),
      // 一只不动不还手的精英巨躯（首领离开竞技场会被拉回去，测久一点的用它）
      big(k, side) {
        const e = TV.mob(k, side || 0, { type: 'brute', elite: true });
        e.hp = e.maxHp = 1e9;
        e.poiseMax = 0;
        return e;
      },
      boss(k) {
        const p = TV.at(k);
        const b = G.spawnBoss('golem', p.x, p.z, 1);
        b.hp = b.maxHp = 1e9;
        b.atkCd = 1e9;
        b.speed = 0;
        b.awake = true;
        return b;
      },
      cast(id, p, sec) {
        T.aim(p.x, p.z);
        G.execSkill(G.skillCtx(id));
        TV.run(sec || 0);
      },
      // 钉住：每一帧推进之后把它放回原处
      pin(e) {
        TV.pins.push({ e, x: e.x, z: e.z });
      },
      run(sec) {
        for (let i = 0; i < Math.round(sec * 60); i++) {
          G.tick(1 / 60);
          for (const q of TV.pins) {
            q.e.x = q.x;
            q.e.z = q.z;
          }
          P.mana = P.maxMana;
          P.life = P.maxLife;
        }
      },
      hold(slot, p, sec) {
        const inp = G.input;
        for (let i = 0; i < Math.round(sec * 60); i++) {
          T.aim(p.x, p.z);
          if (slot === 0) inp.mouse.b[0] = true;
          else inp.keys.KeyQ = true;
          G.tick(1 / 60);
          P.mana = P.maxMana;
        }
        inp.mouse.b[0] = false;
        inp.keys.KeyQ = false;
      },
      n: (e) => TV.cnt.get(e) || 0,
      dmg: (e) => TV.sum.get(e) || 0,
      done() {
        if (TV.orig) G.hitEnemy = TV.orig;
        TV.orig = null;
        G.input.mouse.b[0] = false;
        G.input.keys.KeyQ = false;
        G.clearMinions();
        G.clearEnemies();
        G.resetRanged();
        s.variants = {};
        G.applyVariants();
        P.god = false;
        T.unfix();
      },
    };
  };
  await step('刻式 v2·掷焰「跳焰」：一发落地 4 次、每次落地留火地；落点上的怪被炸、站在火地上接着挨烧', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('ember', 'a');
      const st0 = G.state.stats.vSkipLands || 0;
      const m4 = TV.mob(4, 0), m11 = TV.mob(11, 0), off = TV.mob(6, 5);
      for (const e of [m4, m11, off]) TV.pin(e); // 钉在原地（醒着的靶子会被推开、慢慢挪动，走出火地）
      TV.cast('ember', TV.at(4), 1.4);
      const out = { lands: (G.state.stats.vSkipLands || 0) - st0, fields: G.rangedFields().filter((f) => f.key === 'vSkipT').length, m4: TV.n(m4), m11: TV.n(m11), off: TV.n(off) };
      TV.run(1.6);
      out.m4b = TV.n(m4);
      TV.done();
      return out;
    });
    assert(r.lands >= 3 && r.fields >= 3, '跳焰应落地 3 次以上、每次留火地：' + JSON.stringify(r));
    assert(r.m4 >= 1 && r.m11 >= 1 && r.off === 0 && r.m4b > r.m4, '跳焰的落点 / 火地伤害不对：' + JSON.stringify(r));
    return '落地 ' + r.lands + ' 次，火地 ' + r.fields + ' 片，第一跳的怪共挨 ' + r.m4b + ' 下';
  });
  await step('刻式 v2·掷焰「黏焰」：粘上不当场伤害，1.5 秒后引爆，再给身边的敌人粘上（传两代）', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('ember', 'b');
      const host = TV.mob(6, 0), s1 = TV.mob(6, 3), s2 = TV.mob(6, -3), g2 = TV.mob(6, 6);
      TV.cast('ember', TV.at(6), 0.6);
      const out = { early: TV.n(host), stuck: G.variantState().sticks.length };
      TV.run(1.5);
      out.host = TV.n(host);
      TV.run(3.4);
      out.s1 = TV.n(s1);
      out.s2 = TV.n(s2);
      out.g2 = TV.n(g2);
      out.spread = TV.st('vStickSpread');
      TV.done();
      return out;
    });
    assert(r.early === 0 && r.stuck === 1, '黏焰应先粘上、不当场伤害：' + JSON.stringify(r));
    assert(r.host >= 1 && r.s1 >= 1 && r.s2 >= 1 && r.g2 >= 1 && r.spread >= 3, '黏焰应引爆并往外传两代：' + JSON.stringify(r));
    return '宿主 ' + r.host + '、两侧 ' + r.s1 + '/' + r.s2 + '、第二代 ' + r.g2;
  });
  await step('刻式 v2·飞刃「钉刃」：钉住第一只（定身）、立在原地转 3 秒割身边的怪；不再穿透', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('blade', 'a');
      const m = TV.mob(6, 0), back = TV.mob(8.5, 0);
      TV.cast('blade', TV.at(6), 0.5);
      const out = { traps: G.variantState().traps.length, stun: m.stunT > 0, first: TV.n(m) };
      TV.run(2.6);
      out.m = TV.n(m);
      out.back = TV.n(back);
      TV.run(0.5);
      out.gone = G.variantState().traps.length;
      TV.done();
      return out;
    });
    assert(r.traps === 1 && r.stun && r.first >= 1, '钉刃应钉住第一只并立起锯刃：' + JSON.stringify(r));
    assert(r.m >= 6 && r.back === 0 && r.gone === 0, '锯刃应持续割身边的怪、不穿透到后面、3 秒后收起：' + JSON.stringify(r));
    return '钉住的怪 3 秒内挨 ' + r.m + ' 下，身后 2.5 米的怪 0 下';
  });
  await step('刻式 v2·飞刃「环刃」：不飞出去，绕着你转；放三次三把，贴身的怪被割、远处的不挨', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('blade', 'b');
      const near = TV.mob(2, 0), far = TV.mob(7, 0);
      const p0 = G.state.projectiles.length;
      for (let i = 0; i < 3; i++) TV.cast('blade', TV.at(7), 0.1);
      const out = { orbits: G.variantState().orbits.length, proj: G.state.projectiles.length - p0 };
      TV.run(2.0);
      out.near = TV.n(near);
      out.far = TV.n(far);
      TV.run(2.5);
      out.left = G.variantState().orbits.length;
      TV.done();
      return out;
    });
    assert(r.orbits === 3 && r.proj === 0, '环刃应绕身 3 把、不射出投射物：' + JSON.stringify(r));
    assert(r.near >= 4 && r.far === 0 && r.left === 0, '环刃应割贴身的怪、4 秒后收起：' + JSON.stringify(r));
    return '2 秒内贴身的怪挨 ' + r.near + ' 下';
  });
  await step('刻式 v2·霜环「冰棱」：不再脉冲，朝光环外 9 米内最近的两只射追踪冰棱；身边有三枚冰晶、地上没有霜环', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('nova', 'a', ['ember', null, 'nova', null]);
      const a = TV.mob(7, 0), b = TV.mob(-7.5, 0), c = TV.mob(0, 8.5);
      TV.run(2.0);
      const out = { a: TV.n(a), b: TV.n(b), c: TV.n(c), shards: TV.st('vShards'), crystals: G.variantState().crystals.length, ring: G.world.auraInfo ? G.world.auraInfo().r || 0 : 0 };
      TV.done();
      return out;
    });
    assert(r.shards >= 4 && r.a >= 1 && r.b >= 1 && r.c === 0, '冰棱应只射最近的两只：' + JSON.stringify(r));
    assert(r.crystals === 3, '冰棱应有三枚环身的冰晶：' + JSON.stringify(r));
    return '冰棱 ' + r.shards + ' 枚，两只最近的各中 ' + r.a + '/' + r.b;
  });
  await step('刻式 v2·霜环「冰爆」：光环里冻住一只就炸开，伤到身边的怪并灌入冰霜异常', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('nova', 'b', ['ember', null, 'nova', null]);
      const m = TV.mob(2, 0), n1 = TV.mob(3.5, 0), n2 = TV.mob(2, 1.5);
      G.initBuildUp(m);
      m.bu.cold = 0.97;
      m.buT.cold = 9;
      TV.run(1.0);
      const out = { bursts: TV.st('vNovaBursts'), frozen: m.freeze > 0, n1: +(n1.bu.cold || 0).toFixed(2), n2: +(n2.bu.cold || 0).toFixed(2), n1f: n1.freeze > 0 };
      TV.done();
      return out;
    });
    assert(r.bursts >= 1 && r.frozen, '冰爆应在冻住时炸开：' + JSON.stringify(r));
    assert((r.n1 >= 0.3 || r.n1f) && (r.n2 >= 0.3 || r.n2 > 0), '冰爆应给身边的怪灌冰霜异常：' + JSON.stringify(r));
    return '冰爆 ' + r.bursts + ' 次，身边的怪冰霜异常 ' + r.n1 + ' / ' + r.n2;
  });
  await step('刻式 v2·链雷「雷桩」：插两根桩连起电弧，桩电最近的怪、站在电弧上的怪也挨电', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('arc', 'a');
      const near = TV.mob(7, 4.5), mid = TV.mob(7.4, 0);
      TV.cast('arc', TV.at(7, 3), 0.1);
      TV.cast('arc', TV.at(7, -3), 1.6);
      const VS = G.variantState();
      const out = { pylons: VS.pylons.length, links: VS.links.length, zaps: TV.st('vZaps'), linkHits: TV.st('vLinkHits'), near: TV.n(near), mid: TV.n(mid) };
      TV.done();
      return out;
    });
    assert(r.pylons === 2 && r.links === 1, '雷桩应两根并连起一道电弧：' + JSON.stringify(r));
    assert(r.zaps >= 4 && r.linkHits >= 2 && r.near >= 1 && r.mid >= 2, '雷桩的电击 / 电弧不对：' + JSON.stringify(r));
    return '电击 ' + r.zaps + ' 次，电弧扫中 ' + r.linkHits + ' 次';
  });
  await step('刻式 v2·链雷「过载」：一跳比一跳痛（×1.2 / ×1.44），最后折回给你雷盾', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('arc', 'b');
      T.fix(0.5);
      const a = TV.mob(5, 0), b = TV.mob(9, 0), c = TV.mob(13, 0), d = TV.mob(17, 0);
      TV.cast('arc', TV.at(5), 0.05);
      const P = G.player;
      const out = { a: TV.dmg(a), k1: +(TV.dmg(b) / TV.dmg(a)).toFixed(3), k2: +(TV.dmg(c) / TV.dmg(a)).toFixed(3), d: TV.n(d), shield: P.vShield ? +(P.vShield.v / P.maxLife).toFixed(3) : 0 };
      TV.done();
      return out;
    });
    assert(Math.abs(r.k1 - 1.2) < 0.01 && Math.abs(r.k2 - 1.44) < 0.01 && r.d === 0, '过载每跳应 ×1.2、只连锁 2 次：' + JSON.stringify(r));
    assert(Math.abs(r.shield - 0.12) < 0.005, '过载应给 3 × 4% 最大生命的雷盾：' + JSON.stringify(r));
    return '三跳 ×1 / ×' + r.k1 + ' / ×' + r.k2 + '，雷盾 ' + r.shield + ' 倍最大生命';
  });
  await step('刻式 v2·陨火「熔核」：落地留熔核；掷焰打中熔核旁的敌人时它再炸；6 秒后最后炸一下收起', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('meteor', 'a', ['meteor', null, 'ember', null]);
      const b = TV.big(7);
      TV.pin(b);
      TV.cast('meteor', TV.at(7), 1.0);
      const VS = G.variantState();
      const out = { cores: VS.cores.length, hit0: TV.n(b) };
      for (let i = 0; i < 6; i++) TV.cast('ember', TV.at(7), 0.5);
      out.re = TV.st('vCoreRe');
      TV.run(3.4);
      out.left = VS.cores.length;
      out.total = TV.n(b);
      TV.done();
      return out;
    });
    assert(r.cores === 1 && r.hit0 === 1, '熔核应在落地后留下：' + JSON.stringify(r));
    assert(r.re >= 3 && r.left === 0 && r.total >= 1 + r.re + 1, '火焰伤害应点爆熔核、到时最后炸一下：' + JSON.stringify(r));
    return '再炸 ' + r.re + ' 次，首领共挨陨火 ' + r.total + ' 下';
  });
  await step('刻式 v2·陨火「犁焰」：落地后沿瞄准方向犁 8 米，路上的怪挨一下并被掀向两侧，沟里留火', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('meteor', 'b');
      const a = TV.mob(9, 0.4), b = TV.mob(12, -0.4), far = TV.mob(16.5, 0);
      const a0 = { x: a.x, z: a.z };
      TV.cast('meteor', TV.at(6), 2.0);
      const d = TV.d, side = (a.x - a0.x) * d.z - (a.z - a0.z) * d.x;
      const out = { a: TV.n(a), b: TV.n(b), far: TV.n(far), ploughs: TV.st('vPloughs'), fields: G.rangedFields().filter((f) => f.key === 'vPloughT').length, side: +side.toFixed(2) };
      TV.done();
      return out;
    });
    assert(r.ploughs === 1 && r.a >= 1 && r.b >= 1 && r.far === 0, '犁焰应打中沟里的怪、够不到 8 米外：' + JSON.stringify(r));
    assert(r.fields >= 2 && Math.abs(r.side) > 0.3, '犁焰应留火沟、把怪掀向两侧：' + JSON.stringify(r));
    return '沟里两只各中，火 ' + r.fields + ' 片，侧移 ' + r.side + ' 米';
  });
  await step('刻式 v2·闪袭「残像」：原地留残像嘲讽身边的怪，1.5 秒后炸开', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('blink', 'a');
      const a = TV.mob(1.8, 0.5), b = TV.mob(-1.5, 1.2);
      TV.cast('blink', TV.at(8), 0.3);
      const VS = G.variantState();
      const out = { decoys: VS.decoys.length, taunt: !!(a.taunter && a.taunter.decoy && b.taunter && b.taunter.decoy), early: TV.n(a) };
      TV.run(1.5);
      out.bursts = TV.st('vDecoyBursts');
      out.a = TV.n(a);
      out.b = TV.n(b);
      out.free = !a.taunter || !!a.taunter.dead;
      TV.done();
      return out;
    });
    assert(r.decoys === 1 && r.taunt && r.early === 0, '残像应留在原地并嘲讽身边的怪：' + JSON.stringify(r));
    assert(r.bursts === 1 && r.a >= 1 && r.b >= 1 && r.free, '残像应在 1.5 秒后炸开：' + JSON.stringify(r));
    return '嘲讽 2 只，炸开后各中 ' + r.a + '/' + r.b;
  });
  await step('刻式 v2·闪袭「换影」：和准星附近的怪交换位置并定身它；首领不换位，闪到它身后', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('blink', 'b');
      const P = G.player, p0 = { x: P.x, z: P.z };
      const m = TV.mob(6, 0), m0 = { x: m.x, z: m.z };
      TV.cast('blink', TV.at(6), 0.05);
      const out = { pMoved: +Math.hypot(P.x - m0.x, P.z - m0.z).toFixed(2), mMoved: +Math.hypot(m.x - p0.x, m.z - p0.z).toFixed(2), stun: m.stunT > 0, hit: TV.n(m) };
      TV.done();
      TV.setup('blink', 'b');
      const q0 = { x: P.x, z: P.z };
      const b = TV.boss(7), b0 = { x: b.x, z: b.z };
      TV.cast('blink', TV.at(7), 0.05);
      out.bossStill = Math.hypot(b.x - b0.x, b.z - b0.z) < 0.01;
      out.behind = Math.hypot(P.x - q0.x, P.z - q0.z) > Math.hypot(b.x - q0.x, b.z - q0.z);
      out.bhit = TV.n(b);
      TV.done();
      return out;
    });
    assert(r.pMoved < 0.6 && r.mMoved < 0.6 && r.stun && r.hit === 1, '换影应交换位置并定身：' + JSON.stringify(r));
    assert(r.bossStill && r.behind && r.bhit === 1, '换影对首领应闪到身后、不换位：' + JSON.stringify(r));
    return '换位误差 ' + r.pMoved + ' / ' + r.mMoved + ' 米，首领身后一击';
  });
  await step('刻式 v2·旋风斩「掷旋」：掷出旋刃、在尽头悬停再飞回，去 / 停 / 回都伤人，你自己不转', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('whirl', 'a');
      const m = TV.mob(7, 0);
      TV.cast('whirl', TV.at(7), 0.2);
      const VS = G.variantState();
      const out = { out: !!VS.disc, spin: !!G.player.spinning };
      TV.run(2.6);
      out.back = !VS.disc;
      out.hits = TV.n(m);
      TV.done();
      return out;
    });
    assert(r.out && !r.spin, '掷旋应掷出旋刃、你自己不转：' + JSON.stringify(r));
    assert(r.back && r.hits >= 3, '旋刃应去 / 停 / 回都伤到尽头的怪并飞回：' + JSON.stringify(r));
    return '尽头的怪挨 ' + r.hits + ' 下，旋刃飞回';
  });
  await step('刻式 v2·旋风斩「旋涡斩」：按住转把 5 米内的怪吸到身边，转满 6 下砸地收尾', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('whirl', 'b');
      const P = G.player, m = TV.mob(4.6, 0), d0 = Math.hypot(m.x - P.x, m.z - P.z);
      TV.hold(0, TV.at(5), 2.4);
      const out = { d0: +d0.toFixed(2), d1: +Math.hypot(m.x - P.x, m.z - P.z).toFixed(2), slams: TV.st('vSlams'), n: G.state.stats.vSlamN || 0, hits: TV.n(m) };
      TV.done();
      return out;
    });
    assert(r.d1 < r.d0 - 1.5, '旋涡斩应把怪吸近：' + JSON.stringify(r));
    assert(r.slams === 1 && r.n === 6 && r.hits >= 3, '旋涡斩转满 6 下应砸地收尾：' + JSON.stringify(r));
    return '吸近 ' + r.d0 + ' → ' + r.d1 + ' 米，砸地 ' + r.n + ' 层';
  });
  await step('刻式 v2·影步连斩「影印」：每刀烙一层影印，松手时一齐引爆', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('shadestep', 'a');
      const a = TV.mob(3, 0), b = TV.mob(3, 3);
      TV.hold(0, TV.at(3), 0.5);
      const VS = G.variantState();
      // 松手：下一帧连斩停下，影印引爆
      TV.run(0.4);
      const out = { bursts: TV.st('vMarkBursts'), stacks: TV.st('vMarkStacks'), left: VS.marks.size, marks: TV.st('vMarks'), a: TV.n(a) };
      TV.done();
      return out;
    });
    assert(r.marks >= 2 && r.bursts === 1 && r.stacks >= 2 && r.left === 0, '影印应在松手时一齐引爆：' + JSON.stringify(r));
    return '烙下 ' + r.marks + ' 层，松手引爆 ' + r.stacks + ' 层';
  });
  await step('刻式 v2·影步连斩「影分」：每刀在另一侧留影子，0.3 秒后补同一刀', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('shadestep', 'b');
      const a = TV.mob(3, 0);
      TV.hold(0, TV.at(3), 0.45);
      const own = TV.st('vCloneStrikes');
      TV.run(0.5);
      const out = { strikes: TV.st('vCloneStrikes'), hits: TV.st('vCloneHits'), during: own, a: TV.n(a) };
      TV.done();
      return out;
    });
    assert(r.strikes >= 2 && r.hits >= 2, '影分的影子应补刀：' + JSON.stringify(r));
    return '影子补刀 ' + r.strikes + ' 次、砍中 ' + r.hits + ' 次';
  });
  await step('刻式 v2·烬骸仆从「骸弓」：站在后排射骨箭，打中远处的怪、不贴上去', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('thrall', 'a');
      const P = G.player, m = TV.mob(9, 0);
      const t = G.summonMinion('thrall', P.x - 1, P.z, G.skillCtx('thrall'));
      TV.run(4.0);
      const out = { arrows: TV.st('vArrows'), hits: TV.n(m), gap: +(Math.hypot(t.x - m.x, t.z - m.z) - m.r).toFixed(2) };
      TV.done();
      return out;
    });
    assert(r.arrows >= 2 && r.hits >= 1 && r.gap > 3.5, '骸弓应远远地射箭：' + JSON.stringify(r));
    return '骨箭 ' + r.arrows + ' 支、中 ' + r.hits + '，离目标 ' + r.gap + ' 米';
  });
  await step('刻式 v2·烬骸仆从「骸爆」：倒下时炸一圈骨片，3 秒后在原地拼回来（期间算在数量里）', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('thrall', 'b');
      const P = G.player;
      const t = G.summonMinion('thrall', P.x + 2, P.z, G.skillCtx('thrall'));
      TV.run(1.0);
      const m = T.mob('husk', t.x - P.x + 1.2, t.z - P.z);
      G.hurtMinion(t, 1e9, 'phys', { x: m.x, z: m.z });
      const out = { bursts: TV.st('vBoneBursts'), hit: TV.n(m), count: G.minionCount('thrall'), alive: G.state.minions.filter((q) => q.skill === 'thrall').length };
      TV.run(3.3);
      out.back = TV.st('vBoneBack');
      out.alive2 = G.state.minions.filter((q) => q.skill === 'thrall' && !q.dead).length;
      TV.done();
      return out;
    });
    assert(r.bursts === 1 && r.hit >= 1 && r.count === 1 && r.alive === 0, '骸爆应炸开、等着拼回时仍算一具：' + JSON.stringify(r));
    assert(r.back === 1 && r.alive2 === 1, '骸爆 3 秒后应拼回来：' + JSON.stringify(r));
    return '炸开打中 ' + r.hit + '，3 秒后拼回';
  });
  await step('刻式 v2·石誓守像「磐垒」：扎根不动；护域里你少受 20% 伤害、敌人变慢', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('colossus', 'a');
      const P = G.player;
      const c = G.summonMinion('colossus', P.x + 2, P.z, G.skillCtx('colossus'));
      const m = TV.mob(10, 0);
      TV.run(2.5);
      const c0 = { x: c.x, z: c.z };
      TV.run(2.0);
      const inside = T.mob('husk', c.x - P.x + 2, c.z - P.z);
      const out = { still: Math.hypot(c.x - c0.x, c.z - c0.z) < 0.05, k: +G.bastionK(c.x + 1, c.z).toFixed(3), kOut: G.bastionK(c.x + 9, c.z), slow: G.bastionSlow(inside), slowOut: G.bastionSlow(m), fx: G.world.kvCount('dome') };
      TV.done();
      return out;
    });
    assert(r.still && r.k === 0.8 && r.kOut === 1 && r.slow === 0.25 && r.slowOut === 0 && r.fx >= 1, '磐垒的护域不对：' + JSON.stringify(r));
    return '扎根不动，护域里受伤 ×' + r.k + '、敌人减速 ' + r.slow;
  });
  await step('刻式 v2·石誓守像「掷岩」：朝远处的怪抛巨石，落地砸开', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('colossus', 'b');
      const P = G.player;
      G.summonMinion('colossus', P.x - 1, P.z, G.skillCtx('colossus'));
      const m = TV.mob(9, 0);
      TV.run(5.0);
      const out = { rocks: TV.st('vRocks'), hits: TV.st('vRockHits'), n: TV.n(m) };
      TV.done();
      return out;
    });
    assert(r.rocks >= 1 && r.hits >= 1 && r.n >= 1, '掷岩应抛石砸中远处的怪：' + JSON.stringify(r));
    return '抛石 ' + r.rocks + '，砸中 ' + r.hits;
  });
  await step('刻式 v2·焚骨祭司「焰田」：火弹落地留火地，焰蓄满时燎原——所有火地一齐爆燃', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('pyre', 'a');
      const P = G.player;
      G.summonMinion('pyre', P.x - 1, P.z, G.skillCtx('pyre'));
      for (let i = 0; i < 6; i++) TV.mob(7.5, (i - 2.5) * 0.9);
      let fields = 0;
      for (let k = 0; k < 16 && !(TV.st('vFlares') > 0); k++) {
        TV.run(0.5);
        fields = Math.max(fields, G.rangedFields().filter((f) => f.pyre).length);
      }
      const out = { fields, flares: TV.st('vFlares'), flared: TV.st('vFlareFields'), meteors: TV.st('pyreMeteors') };
      TV.done();
      return out;
    });
    assert(r.fields >= 1 && r.flares >= 1 && r.flared >= 1 && r.meteors === 0, '焰田应留火地并燎原（不放坠焰）：' + JSON.stringify(r));
    return '最多 ' + r.fields + ' 片火地，燎原引爆 ' + r.flared + ' 片';
  });
  await step('刻式 v2·焚骨祭司「魂链」：不掷火弹，灼链盯着目标越烧越旺，并分一道细链给旁边的怪', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('pyre', 'b');
      const P = G.player;
      G.summonMinion('pyre', P.x - 1, P.z, G.skillCtx('pyre'));
      const b = TV.big(8), side = TV.mob(8, 2.6);
      TV.run(5.0);
      const L = G.SKILLS.pyre.link;
      const out = { ticks: TV.st('vLinkTicks'), side: TV.st('vLinkSide'), k: +(G.state.stats.vLinkK || 0).toFixed(3), k1: L.k1, bolts: G.minionBolts(), hits: TV.st('pyreHits'), sideHit: TV.n(side) };
      TV.done();
      return out;
    });
    assert(r.ticks >= 10 && r.side >= 5 && r.sideHit >= 5 && r.k === r.k1 && r.bolts === 0 && r.hits === 0, '魂链应只引导灼链、烧满后翻倍、分出细链：' + JSON.stringify(r));
    return '灼链 ' + r.ticks + ' 跳、细链 ' + r.side + ' 跳，烧满倍率 ' + r.k;
  });
  await step('刻式 v2·黑洞「双极」：一次两个小洞，中间的引力索伤人，并把怪拽向索', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('blackhole', 'a');
      const mid = TV.mob(7.2, 0.3), pulled = TV.mob(9.8, 0.6);
      const d = TV.d, P = G.player, line = (e) => Math.abs((e.x - P.x) * d.x + (e.z - P.z) * d.z - 7);
      const l0 = line(pulled);
      TV.cast('blackhole', TV.at(7), 1.5);
      const holes = G.chaosHoles();
      const out = { holes: holes.length, linked: holes.length === 2 && holes[0].twin === holes[1], tether: TV.st('vTetherHits'), mid: TV.n(mid), l0: +l0.toFixed(2), l1: +line(pulled).toFixed(2), band: G.world.kvCount('band') };
      TV.done();
      return out;
    });
    assert(r.holes === 2 && r.linked && r.band === 1, '双极应开两个连着索的洞：' + JSON.stringify(r));
    assert(r.tether >= 1 && r.mid >= 3 && r.l1 < r.l0 - 0.5, '引力索应伤人并把怪拽过来：' + JSON.stringify(r));
    return '索上的怪挨 ' + r.mid + ' 跳，被拽 ' + r.l0 + ' → ' + r.l1 + ' 米';
  });
  await step('刻式 v2·黑洞「坍缩」：每跳攒质量、黑洞变大；再按一次技能键提前坍缩，伤害按质量算', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('blackhole', 'b');
      for (let i = 0; i < 5; i++) TV.mob(7, (i - 2) * 0.7);
      const b = TV.boss(7.5);
      TV.cast('blackhole', TV.at(7), 1.5);
      const h = G.chaosHoles()[0];
      const out = { mass: h ? h.mass : -1, grew: h ? +(h.R / h.R0).toFixed(2) : 0 };
      const before = TV.dmg(b);
      G.input.tap[0] = 0.2; // 再按一次（冷却中照样能引爆）
      TV.run(0.1);
      out.collapses = TV.st('vCollapses');
      out.holes = G.chaosHoles().length;
      out.burst = +((TV.dmg(b) - before) / Math.max(1, before / Math.max(1, TV.n(b) - 1))).toFixed(1);
      TV.done();
      return out;
    });
    assert(r.mass >= 20 && r.grew > 1.3, '坍缩应攒质量、变大：' + JSON.stringify(r));
    assert(r.collapses === 1 && r.holes === 0 && r.burst > 3, '再按一次应提前坍缩、按质量重击：' + JSON.stringify(r));
    return '质量 ' + r.mass + '、半径 ×' + r.grew + '，坍缩一击约等于 ' + r.burst + ' 跳';
  });

  await step('渊契只改原式：戴着引力核时双极照常开两个连着索的洞、坍缩照常再按引爆（原式才跟着你）；怒潮下旋涡斩不攒潮势；电桥戒下过载 / 雷桩不留桥；骸王冠下骸弓照常 3 具；陨织袍下熔核照常手动放、不保留魔力', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      const s = G.save, P = G.player, out = {}, keep = Object.assign({}, s.equip);
      const wear = (rq) => {
        s.equip[G.RELICS[rq].slot] = G.rollRelic(rq, 50, 0.5);
        G.computeStats();
      };
      const off = (rq) => {
        s.equip[G.RELICS[rq].slot] = null;
        G.computeStats();
      };
      // 引力核 + 双极
      TV.setup('blackhole', 'a');
      wear('yinli');
      TV.cast('blackhole', TV.at(7), 0.5);
      const hs = G.chaosHoles();
      out.twin = [hs.length, hs.length === 2 && hs[0].twin === hs[1], G.relicHoleList().length];
      TV.done();
      // 引力核 + 坍缩：再按一次当场引爆
      TV.setup('blackhole', 'b');
      wear('yinli');
      for (let i = 0; i < 3; i++) TV.mob(7, (i - 1) * 0.7);
      TV.cast('blackhole', TV.at(7), 1.2);
      const c0 = !!G.chaosHoles().find((h) => h.collapse);
      G.input.tap[0] = 0.2;
      TV.run(0.1);
      out.collapse = [c0, TV.st('vCollapses'), G.relicHoleList().length];
      TV.done();
      // 引力核 + 原式：照旧跟着你
      TV.setup('blackhole', 'o');
      wear('yinli');
      TV.cast('blackhole', TV.at(7), 0.1);
      out.plain = G.relicHoleList().length;
      TV.done();
      off('yinli');
      // 怒潮 + 旋涡斩：不攒潮势
      TV.setup('whirl', 'b');
      wear('nuchao');
      TV.mob(1.5, 0);
      TV.hold(0, TV.at(2), 0.8);
      out.tide = G.relicState.spin;
      TV.done();
      G.relicTick(1 / 60);
      off('nuchao');
      // 电桥戒 + 过载 / 雷桩：不留桥
      out.bridge = [];
      for (const v of ['b', 'a']) {
        TV.setup('arc', v);
        wear('dianqiao');
        for (let i = 0; i < 3; i++) TV.mob(5 + i * 2, 0);
        TV.cast('arc', TV.at(5), 0.6);
        out.bridge.push(G.relicState.bridges.length);
        TV.done();
        G.relicReset();
      }
      off('dianqiao');
      // 骸王冠 + 骸弓：照常 3 具、不是骸王
      TV.setup('thrall', 'a');
      wear('haiwang');
      const mc = G.skillCtx('thrall').minion;
      out.king = [mc.cap, !!mc.king];
      TV.done();
      off('haiwang');
      // 陨织袍 + 熔核：照常手动放、不保留魔力
      TV.setup('meteor', 'a');
      wear('zhuixing');
      out.star = [P.reservePct, G.relicNoCast(0, 'meteor')];
      TV.done();
      Object.assign(s.equip, keep);
      G.computeStats();
      return out;
    });
    assert(r.twin.join() === '2,true,0', '戴着引力核时双极应照常开两个连着的洞：' + JSON.stringify(r.twin));
    assert(r.collapse.join() === 'true,1,0', '戴着引力核时坍缩应照常再按引爆：' + JSON.stringify(r.collapse));
    assert(r.plain === 1, '原式黑洞仍应跟着你：' + r.plain);
    assert(r.tide === 0 && r.bridge.join() === '0,0' && r.king.join() === '3,false' && r.star.join() === '0,false', '其余渊契不该改刻式 A / B：' + JSON.stringify(r));
    return '双极 ' + r.twin[0] + ' 洞 · 坍缩引爆 ' + r.collapse[1] + ' · 原式随核 ' + r.plain;
  });
  await step('刻式 v2·黑旋风「护涡」：三团旋风绕着你转，绞贴身的怪、吞掉敌方弹丸', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('vortex', 'a');
      const P = G.player, m = TV.mob(2.4, 0);
      TV.cast('vortex', TV.at(6), 0.6);
      const vs = G.chaosVortices().filter((v) => v.guard);
      const rr = vs.map((v) => Math.hypot(v.x - P.x, v.z - P.z));
      // 一发朝你飞来的敌方弹丸，穿过旋风那一圈
      const e0 = TV.st('vEaten');
      const v0 = vs[0], sx = v0.x + (v0.x - P.x) * 0.1, sz = v0.z + (v0.z - P.z) * 0.1;
      G.spawnProjectile({ owner: 'e', x: sx, z: sz, dx: P.x - sx, dz: P.z - sz, speed: 2, r: 0.3, life: 5, dmg: 1, dtype: 'phys' });
      TV.run(1.2);
      const out = { n: vs.length, rmin: +Math.min.apply(null, rr).toFixed(2), rmax: +Math.max.apply(null, rr).toFixed(2), eaten: TV.st('vEaten') - e0, hits: TV.n(m) };
      TV.done();
      return out;
    });
    assert(r.n === 3 && r.rmin > 1.8 && r.rmax < 3.0, '护涡应三团绕着你转：' + JSON.stringify(r));
    assert(r.eaten >= 1 && r.hits >= 3, '护涡应吞掉弹丸、绞贴身的怪：' + JSON.stringify(r));
    return '绕身半径 ' + r.rmin + '–' + r.rmax + '，吞弹 ' + r.eaten + '，绞中 ' + r.hits;
  });
  await step('刻式 v2·黑旋风「汇涡」：旋风互相靠拢，撞到一起合成层数更高的一团', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('vortex', 'b');
      TV.cast('vortex', TV.at(6), 0.3);
      G.player.cds = {};
      TV.cast('vortex', TV.at(6), 1.5);
      const vs = G.chaosVortices().filter((v) => v.lvl);
      const out = { merges: TV.st('vMerges'), top: G.state.stats.vMergeTop || 0, n: vs.length, big: vs.some((v) => v.R > v.R0 * 1.3) };
      TV.done();
      return out;
    });
    assert(r.merges >= 2 && r.top >= 3 && r.big, '汇涡应合成层数更高、更大的一团：' + JSON.stringify(r));
    return '合并 ' + r.merges + ' 次，最高 ' + r.top + ' 层';
  });
  await step('刻式 v2·黑焰「蚀印」：每一击叠一层蚀印，6 层炸开；附带比例是原式的一半', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('ember', 'o', ['ember', null, 'blackflame', null]);
      G.save.variants.blackflame = 'a';
      G.applyVariants();
      G.computeStats();
      const b = TV.big(6);
      TV.pin(b);
      const F = G.flamePct();
      let casts = 0;
      while (casts < 10 && !TV.st('vBrandBursts')) {
        TV.cast('ember', TV.at(6), 0.4);
        casts++;
      }
      TV.run(0.3);
      const out = { bursts: TV.st('vBrandBursts'), F: +F.toFixed(2), brand: b.vBrand || 0, casts, hits: TV.n(b) };
      G.save.variants.blackflame = 'o';
      TV.done();
      out.Fo = +G.flamePct().toFixed(2);
      return out;
    });
    assert(r.bursts === 1 && r.brand === 0 && r.casts === 6 && Math.abs(r.F * 2 - r.Fo) < 0.05, '蚀印应 6 层炸开、附带比例减半：' + JSON.stringify(r));
    return '6 击后炸开 1 次，附带 ' + r.F + '%（原式 ' + r.Fo + '%）';
  });
  await step('刻式 v2·黑焰「传焰」：命中点燃黑焰（不直接加伤害），宿主死时带着没烧完的跳到下一个', async () => {
    await ev(TVDEF);
    const r = await ev(() => {
      TV.setup('ember', 'o', ['ember', null, 'blackflame', null]);
      G.save.variants.blackflame = 'b';
      G.applyVariants();
      G.computeStats();
      const a = TV.mob(6, 0), b = TV.mob(6, 3.5);
      T.fix(0.5);
      TV.cast('ember', TV.at(6), 0.4);
      const pool = a.vDot ? a.vDot.pool : 0;
      const parts = G.calcHit(G.skillCtx('ember'), 1).parts;
      G.killEnemy(a, {});
      const out = { pool: +pool.toFixed(1), chaosInHit: parts.chaos || 0, jumps: TV.st('vDotJumps'), bPool: b.vDot ? +b.vDot.pool.toFixed(1) : 0, depth: b.vDot ? b.vDot.depth : -1 };
      TV.watch = '*proc';
      TV.run(2.4);
      out.burned = TV.n(b);
      G.save.variants.blackflame = 'o';
      TV.done();
      return out;
    });
    assert(r.pool > 0 && r.chaosInHit === 0, '传焰应点在身上、不加进这一击：' + JSON.stringify(r));
    assert(r.jumps === 1 && r.depth === 1 && r.bPool > 0 && r.burned >= 4, '宿主死时黑焰应跳到下一个并接着烧：' + JSON.stringify(r));
    return '点燃 ' + r.pool + '，跳过去 ' + r.bPool + '（深 ' + r.depth + '），烧了 ' + r.burned + ' 跳';
  });
  await step('刻式 v2·旧存档：第二版之前的刻式按位置留着（a → a、b → b），免费重选一次还回来，并提示一次「刻式重做」', async () => {
    const r = await ev((keep) => {
      T.arena();
      const s = G.save, out = {};
      s.skills.ember = 20;
      s.skills.blade = 20;
      G.persist();
      const raw = JSON.parse(localStorage.getItem('cinder-abyss-save-v1'));
      delete raw.variantGen;
      delete raw.varNote;
      raw.variants = { ember: 'a', blade: 'b' };
      raw.variantFree = { ember: true, blade: true, nova: true };
      if (raw.tut) delete raw.tut.variant2;
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      out.vars = T.canon(G.save.variants);
      out.free = T.canon(G.save.variantFree);
      out.cost = G.variantCost('ember') + G.variantCost('blade');
      out.names = G.SKILLS.ember.vname + '/' + G.SKILLS.blade.vname;
      out.note = G.save.varNote === true && G.variantRedone === 1;
      out.gen = G.save.variantGen;
      // 再读一次（提示还没看过）：免费那一次不会再被清，提示照样在
      G.save.variantFree.ember = true;
      G.persist();
      G.loadSave();
      out.keep = G.save.variantFree.ember === true && G.variantRedone === 1;
      // 看过提示之后不再提示
      G.save.tut.variant2 = 1;
      G.save.varNote = false;
      G.persist();
      G.loadSave();
      out.seen = G.variantRedone === 0 && G.save.varNote === false;
      if (keep) localStorage.setItem('cinder-abyss-save-v1', keep);
      G.loadSave();
      G.computeStats();
      return out;
    }, varKeep);
    assert(r.vars === '{"blade":"b","ember":"a"}' && r.free === '{}' && r.cost === 0 && r.names === '跳焰/环刃' && r.gen === 2, '旧刻式应按位置保留、免费重选还回来：' + JSON.stringify(r));
    assert(r.note && r.keep && r.seen, '「刻式重做」提示应只出一次：' + JSON.stringify(r));
    return '旧 a / b 对到 ' + r.names + '，免费重选还回来，提示一次';
  });

  await step('刻式：存档——选了的刻式读档后还在；坏数据（未知 id、\'c\'）被丢掉；旧存档没有这一项，全部原式', async () => {
    const r = await ev((keep) => {
      T.arena();
      const out = {};
      const s = G.save;
      s.skills.ember = Math.max(10, s.skills.ember || 0);
      s.skills.vortex = 20;
      s.variants = { ember: 'b', vortex: 'a' };
      s.variantFree = { ember: true, vortex: true };
      G.persist();
      G.loadSave();
      out.kept = G.save.variants.ember === 'b' && G.save.variants.vortex === 'a' && G.SKILLS.ember.vname === '黏焰' && G.SKILLS.vortex.vname === '护涡' && G.save.variantFree.ember === true;
      // 坏数据
      const raw = JSON.parse(localStorage.getItem('cinder-abyss-save-v1'));
      raw.variants = { ember: 'c', nope: 'a', vortex: 'b', riposte: 'a', blade: 5 };
      raw.variantFree = { nope: true, arc: 'yes', blade: true };
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      out.bad = T.canon(G.save.variants) === '{"vortex":"b"}' && T.canon(G.save.variantFree) === '{"blade":true,"vortex":true}' && G.SKILLS.ember === G.SKILL_V.ember.o && G.SKILLS.vortex.vname === '汇涡';
      // 宝石不到 10 级：保留但不生效
      raw.variants = { ember: 'a' };
      raw.skills.ember = 4;
      raw.level = 1;
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      out.low = G.save.variants.ember === 'a' && G.variantOf('ember') === 'o' && G.SKILLS.ember === G.SKILL_V.ember.o;
      // 旧存档：没有 variants / variantFree
      delete raw.variants;
      delete raw.variantFree;
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      out.old = T.canon(G.save.variants) === '{}' && T.canon(G.save.variantFree) === '{}' && T.canon(G.SKILLS) === T.canon(G.SKILL_BASE);
      // 放回这一组步骤开始前的存档
      if (keep) localStorage.setItem('cinder-abyss-save-v1', keep);
      else localStorage.removeItem('cinder-abyss-save-v1');
      G.loadSave();
      G.computeStats();
      out.restored = T.canon(G.SKILLS) === T.canon(G.SKILL_BASE);
      return out;
    }, varKeep);
    assert(r.kept, '选了的刻式读档后丢了：' + JSON.stringify(r));
    assert(r.bad, '坏数据没被丢掉：' + JSON.stringify(r));
    assert(r.low, '宝石不到解锁等级的刻式应保留但不生效：' + JSON.stringify(r));
    assert(r.old && r.restored, '旧存档应全部原式：' + JSON.stringify(r));
    return '读档保留、坏数据丢弃、低等级不生效、旧存档原式';
  });

  // ------------------------------------------------------------------ D2 渊契（稀有度 4）
  // 通用的攻击上下文用飞刃（裂石击会被武器普攻取代、不再是可学的技能）
  // 每一步开头 RQT.begin(id)：标准刃、除武器外的部位全空、只穿这一件渊契（物品等级 50、完美度 0.5）；结尾 RQT.end() 还原装备和技能栏
  await step('渊契数据：G.rollRelic 每件 × 3 个物品等级，部位 / 基底 / 词缀行合法（数值在区间里）、只在非武器部位；存档往返后都留着（isItem 认）、部位不对的被丢掉；稀有度名「渊契」、颜色是单一常量；提示卡是翠色并写着机制、无法改造', async () => {
    // 页面里的渊契测试小工具（RQT），后面几步都用
    await ev(() => {
      const P = G.player;
      window.RQT = {
        begin(id) {
          T.unfix();
          T.arena();
          RQT.keep = { equip: Object.assign({}, G.save.equip), build: T.buildSnap(), sup: G.save.supports.slice() };
          for (const sl of G.SLOTS) if (sl !== 'weapon') G.save.equip[sl] = null;
          G.save.bar = [null, null, null, null];
          if (id) G.save.equip[G.RELICS[id].slot] = G.rollRelic(id, 50, 0.5);
          G.computeStats();
          G.relicReset();
          G.relicState.crit = 0;
          P.life = P.maxLife;
          P.mana = P.maxMana;
          P.cds = {};
          P.roll.cd = 0;
          for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) G.input.keys[k] = false;
        },
        learn(id, slot) {
          G.save.skills[id] = Math.max(G.save.skills[id] || 1, 10);
          if (!Array.isArray(G.save.sockets[id])) G.save.sockets[id] = [null, null, null];
          else G.save.sockets[id] = [null, null, null];
          if (slot !== undefined) G.save.bar[slot] = id;
          G.computeStats();
        },
        // 伤害按固定随机数（0.999：不暴击、取区间上沿）算的一击
        hit(ctx, mult) {
          return G.calcHit(ctx, mult === undefined ? 1 : mult).total;
        },
        end() {
          T.unfix();
          G.clearMinions();
          G.relicReset();
          if (RQT.keep) {
            for (const sl of G.SLOTS) G.save.equip[sl] = RQT.keep.equip[sl] || null; // 存档里原本没有这个部位的键时也要清掉（只跑几步时的新存档）
            G.save.supports = RQT.keep.sup;
            T.buildRestore(RQT.keep.build);
          }
          G.computeStats();
          T.arena();
        },
      };
    });
    const r = await ev(() => {
      RQT.begin(null);
      const out = { bad: [], n: 0 };
      for (const id of G.RELIC_IDS) {
        const R = G.RELICS[id];
        for (const il of [21, 37, 57]) {
          const it = G.rollRelic(id, il);
          out.n++;
          const lines = it.affixes.length === R.lines.length && it.affixes.every((a, i) => { const rg = G.relicLineRange(id, il, i); return a.id === R.lines[i].id && a.v >= rg[0] && a.v <= rg[1] && rg[1] >= rg[0] && rg[0] >= 1; });
          if (!(it.rarity === 4 && it.rq === id && it.slot === R.slot && R.slot !== 'weapon' && it.baseIdx === R.base && G.BASES[R.slot][R.base].names.indexOf(it.baseName) >= 0 && it.name === R.name && lines)) out.bad.push(id + '@' + il);
        }
      }
      out.ids = G.RELIC_IDS.length;
      out.weaponless = Object.keys(G.RELICS).every((id) => G.RELICS[id].slot !== 'weapon');
      out.notUq = G.RELIC_IDS.every((id) => !G.UNIQUES[id]);
      out.name = G.RARITY_NAME[4];
      out.color = G.RARITY_COLOR[4] === G.RELIC_COLOR ? G.RELIC_COLOR : 'mismatch';
      // 存档往返：13 件放进背包，再塞一件部位被改坏的
      G.save.bag.length = 0;
      for (const id of G.RELIC_IDS) G.save.bag.push(G.rollRelic(id, 44));
      G.persist();
      const raw = JSON.parse(localStorage.getItem('cinder-abyss-save-v1'));
      const wrong = G.rollRelic('panzhong', 44);
      wrong.slot = 'ring';
      const off = G.rollRelic('qianmu', 44);
      off.affixes[0].v = 99999; // 数值超出区间：读档时夹回去
      raw.bag.push(wrong, off);
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      const rel = G.save.bag.filter((it) => it.rarity === 4);
      out.kept = rel.length;
      const q = rel[rel.length - 1];
      out.clamp = q && q.rq === 'qianmu' ? [q.affixes[0].v, G.relicLineRange('qianmu', 44, 0)[1]] : null;
      // 提示卡
      G.ui.open('inv');
      const cell = document.querySelector('.cell.r4[data-item]');
      if (cell) cell.click();
      const nm = document.querySelector('.detail-card .icard.r4 .ic-name');
      out.nameColor = nm ? getComputedStyle(nm).color : null;
      const txt = T.bodyText();
      const selIt = cell && G.save.bag.find((x) => x.uid === cell.dataset.item);
      out.mech = !!selIt && txt.indexOf(G.RELICS[selIt.rq].mechName) >= 0 && txt.indexOf(G.RELICS[selIt.rq].mechDesc.slice(0, 12)) >= 0 && txt.indexOf('渊契无法改造') >= 0;
      out.locked = !!document.querySelector('.craft-grid.locked');
      G.ui.close();
      G.save.bag.length = 0;
      RQT.end();
      return out;
    });
    assert(r.bad.length === 0 && r.n === 39 && r.ids === 13, '掷出来的渊契不合法：' + JSON.stringify(r.bad));
    assert(r.weaponless && r.notUq && r.name === '渊契' && r.color === '#6fe0b0', '稀有度 / 部位 / 颜色不对：' + JSON.stringify(r));
    assert(r.kept === 14 && r.clamp && r.clamp[0] === r.clamp[1], '存档往返应留下 13 + 1 件（部位不对的丢掉、数值夹回区间）：' + JSON.stringify(r));
    assert(r.nameColor === 'rgb(111, 224, 176)' && r.mech && r.locked, '提示卡应是翠色、写着机制和无法改造：' + JSON.stringify(r));
    return r.n + ' 件 · 往返留下 ' + r.kept;
  });

  await step('渊契掉落：首领那一件按层级的几率（和烬铸一样：层级 1 15%、层级 2 起 25%，N = 4000，±15%），烈印 W ≥ 6 时 × 1.5、封顶 35%（层级 1 22.5%、层级 2 35%），层级 0 不掉也不计保底；连续 2 次没掉第 3 次必掉、掉了清零；和烬铸的判定、保底互不影响；异兆 / 拾烬客的来源关着、烈印的随渊印打开（关着时保底满了也不掉，打开后各自按保底掉）', async () => {
    const r = await ev(() => {
      RQT.begin(null);
      const P = G.player, U = G.save.relic, D = G.RELIC_DROP, S = G.state;
      const out = {};
      // 固定种子的伪随机：几率检查不随运行抖动
      const rand0 = Math.random;
      let a = 20261118;
      Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const rate = (kind, tier) => { const id = G.RELIC_BY_BOSS[kind]; let n = 0; for (let i = 0; i < 4000; i++) { delete U.pity[id]; if (G.relicBossRoll(kind, tier)) n++; } delete U.pity[id]; return n / 4000; };
      const uq0 = JSON.stringify(G.save.uniq.pity);
      // 烈印的 W 先按 0（D3 上线后 G.runSealW 是真的，量完放回去）
      const sw0 = G.runSealW;
      G.runSealW = () => 0;
      out.r1 = rate('golem', 1);
      out.r2 = rate('warden', 2);
      out.r3 = rate('behemoth', 3);
      // 烈印 W ≥ 6：× sealMul，最终不超过 sealCap
      G.runSealW = () => 6;
      out.s1 = rate('golem', 1);
      out.s2 = rate('warden', 2);
      if (sw0) G.runSealW = sw0;
      else delete G.runSealW;
      let n0 = 0;
      for (let i = 0; i < 4000; i++) if (G.relicBossRoll('lord', 0)) n0++;
      out.t0 = [n0, U.pity.haiwang || 0];
      out.uqSame = JSON.stringify(G.save.uniq.pity) === uq0;
      Math.random = rand0;
      out.map = Object.keys(G.RELIC_BY_BOSS).sort().map((k) => k + ':' + G.RELIC_BY_BOSS[k]).join();
      // 保底：掷骰永远不中
      T.fix(0.999);
      delete U.pity.huixuan;
      let k = 0;
      while (!G.relicBossRoll('weaver', 1) && k < 30) k++;
      out.pity = [k + 1, U.pity.huixuan || 0];
      // 烬铸掉落不动渊契的保底
      U.pity.panzhong = 4;
      const tier0 = S.tier;
      S.tier = 1;
      const uqp = Object.assign({}, G.save.uniq.pity);
      G.uniqueDrop({ bossKind: 'golem', x: P.x, z: P.z, isBoss: true }, 30);
      out.rqSame = U.pity.panzhong === 4;
      G.save.uniq.pity = uqp;
      // 关着的来源：保底满了也不掉（D3 渊印、D4 异兆上线后这三个来源默认开着：这里先临时关掉再验）
      out.src = [D.src.boss, D.src.enc, D.src.seal, D.src.trader].join();
      const srcOrig = Object.assign({}, D.src);
      D.src.enc = D.src.seal = D.src.trader = false;
      U.pity.dianqiao = 99;
      U.pity.seal = 99;
      out.off = [G.relicEncDrop('guard', 40, P.x, P.z), G.relicSealDrop({ isBoss: true, x: P.x, z: P.z }, 40), G.relicTraderPick()].map((v) => v === null).join();
      // 打开异兆来源：保底满了就掉（层级 ≥ 1）
      const src0 = srcOrig;
      D.src.enc = true;
      U.pity.dianqiao = D.enc.pity;
      const it = G.relicEncDrop('guard', 40, P.x, P.z);
      out.encOn = [it && it.rq, U.pity.dianqiao || 0];
      // 烈印：W 不够不掉，够了按 'seal' 保底掉陨织袍 / 渊缚链
      D.src.seal = true;
      U.pity.seal = D.seal.pity;
      out.sealLow = G.relicSealDrop({ isBoss: true, x: P.x, z: P.z }, 40) === null;
      const rsw = G.runSealW; // 渊印提供的 G.runSealW：借用一下，最后放回（不能删）
      G.runSealW = () => 6;
      const s2 = G.relicSealDrop({ isBoss: true, x: P.x, z: P.z }, 40);
      out.sealOn = [s2 && D.seal.ids.indexOf(s2.rq) >= 0, U.pity.seal || 0];
      G.runSealW = rsw;
      Object.assign(D.src, src0, srcOrig);
      S.tier = tier0;
      T.unfix();
      T.clearLoot();
      U.pity = {};
      RQT.end();
      return out;
    });
    const near = (v, p) => Math.abs(v - p) <= p * 0.15;
    assert(near(r.r1, 0.15) && near(r.r2, 0.25) && near(r.r3, 0.25), '首领渊契的几率不对：' + JSON.stringify(r));
    assert(near(r.s1, 0.225) && near(r.s2, 0.35), '烈印下首领渊契应 × 1.5、封顶 35%：' + JSON.stringify(r));
    assert(r.t0.join() === '0,0', '层级 0 不该掉、不该计保底：' + r.t0);
    assert(r.pity.join() === '3,0', '保底应在第 3 次必掉并清零：' + r.pity);
    assert(r.uqSame && r.rqSame, '渊契和烬铸的保底互相影响了：' + JSON.stringify(r));
    assert(r.map === 'behemoth:yinli,golem:panzhong,lord:haiwang,warden:nuchao,weaver:huixuan', '首领 → 渊契对应不对：' + r.map);
    assert(r.src === 'true,true,true,true' && r.off === 'true,true,true', '异兆 / 烈印 / 拾烬客来源应随 D3 / D4 打开、关掉时不掉：' + JSON.stringify(r));
    assert(r.encOn.join() === 'dianqiao,0' && r.sealLow && r.sealOn.join() === 'true,0', '打开来源后应按保底掉落：' + JSON.stringify(r));
    return '层级 1 ' + (r.r1 * 100).toFixed(1) + '% · 层级 2 ' + (r.r2 * 100).toFixed(1) + '% · 烈印 ' + (r.s1 * 100).toFixed(1) + '% / ' + (r.s2 * 100).toFixed(1) + '% · 保底第 ' + r.pity[0] + ' 次';
  });

  await step('踏震（磐踵）：翻滚落地震地，半径 4.5 米（RELIC_MECH.panzhong.r）内的敌人吃 1.1 倍武器伤害（物理攻击，吃伤害加成），外面的不吃；两次至少隔 0.8 秒；翻滚冷却 +30%，摘下就恢复', async () => {
    const r = await ev(() => {
      RQT.begin('panzhong');
      const P = G.player, S = P.S, A = G.RELIC_MECH.panzhong;
      const d = T.openDir(10);
      T.aim(P.x + d.x * 10, P.z + d.z * 10);
      const L = P.moveSpeed * 2.6 * 0.32;
      const lx = P.x + d.x * L, lz = P.z + d.z * L;
      const R = A.r * Math.sqrt(Math.max(0.1, 1 + (S.area || 0) / 100));
      const near = T.mob('husk', lx + d.z * 1.4 - P.x, lz - d.x * 1.4 - P.z);
      const far = T.mob('husk', lx - d.z * (R + 2.5) - P.x, lz + d.x * (R + 2.5) - P.z);
      T.fix(0.999);
      const st0 = G.state.stats.relicStomps || 0;
      const ok = G.dodge();
      const out = { ok, cd: [P.roll.cdMax, 0.9 * (1 - Math.min(90, S.dodgeCd || 0) / 100) * (1 + A.rollCd)] };
      G.debug.step(0.5);
      const wp = G.weaponStats(G.save.equip.weapon);
      const expect = (wp.min + (wp.max - wp.min) * 0.999) * A.mult * (1 + ((S.incAll || 0) + (S.incPhys || 0)) / 100) * (1 + (S.moreDmg || 0) / 100) * (1 - Math.min(90, S.ownLess || 0) / 100);
      out.near = [Math.round(near.maxHp - near.hp), Math.round(expect)];
      out.far = Math.round(far.maxHp - far.hp);
      out.stomps = (G.state.stats.relicStomps || 0) - st0;
      out.gap = G.relicLand();
      G.save.equip.boots = null;
      G.computeStats();
      P.roll.cd = 0;
      G.debug.step(0.1);
      G.dodge();
      out.cd0 = [P.roll.cdMax, 0.9 * (1 - Math.min(90, P.S.dodgeCd || 0) / 100)];
      G.debug.step(0.5);
      RQT.end();
      return out;
    });
    assert(r.ok && Math.abs(r.cd[0] - r.cd[1]) < 1e-6 && Math.abs(r.cd0[0] - r.cd0[1]) < 1e-6, '翻滚冷却不对：' + JSON.stringify(r));
    assert(Math.abs(r.near[0] - r.near[1]) <= Math.max(2, r.near[1] * 0.02) && r.far === 0 && r.stomps === 1, '踏震的伤害 / 范围不对：' + JSON.stringify(r));
    assert(r.gap === 0, '0.8 秒内不该再震一次');
    return '踏震 ' + r.near[0] + ' · 冷却 ' + r.cd[0].toFixed(2) + ' 秒';
  });

  await step('蓄潮（怒潮）：旋风斩每跳只打 55%、攒 1 层（上限 12）；松手后以你为中心炸开（半径 × 1.4），每层 0.5 倍满额一跳，层数清零；没穿时每跳照常满额', async () => {
    const r = await ev(() => {
      RQT.begin('nuchao');
      RQT.learn('whirl', 0);
      const P = G.player, B = G.RELIC_MECH.nuchao;
      const ctx = G.skillCtx('whirl');
      const R = ctx.sk.radius * Math.sqrt(ctx.area);
      const a = T.mob('husk', 0, -1.2);
      const ring = T.mob('husk', 0, -(R * 1.2 + 0.55));
      T.fix(0.999);
      const pulse = RQT.hit(ctx, 1);
      P.cast = { slot: 0, id: 'whirl', channel: true, pulses: 0, t: 0, nextT: 1e9, cancelT: 0, dur: Infinity, move: 0.6, fired: true };
      const per = [];
      for (let i = 0; i < 14; i++) {
        a.x = P.x;
        a.z = P.z - 1.2;
        const h0 = a.hp;
        P.cast.pulses++;
        G.execSkill(G.skillCtx('whirl'));
        per.push(h0 - a.hp);
      }
      const out = { per: [Math.round(per[0]), Math.round(pulse * B.pulse)], spin: G.relicState.spin, ringPulse: Math.round(ring.maxHp - ring.hp) };
      const r0 = ring.hp;
      P.cast = null;
      G.relicTick(1 / 60);
      out.burst = [Math.round(r0 - ring.hp), Math.round(pulse * B.max * B.burst)];
      out.after = G.relicState.spin;
      // 没穿：每跳满额、不攒层
      G.save.equip.gloves = null;
      G.computeStats();
      const h1 = a.hp;
      P.cast = { slot: 0, id: 'whirl', channel: true, pulses: 1, t: 0, nextT: 1e9, cancelT: 0, dur: Infinity, move: 0.6, fired: true };
      const c2 = G.skillCtx('whirl');
      const full = RQT.hit(c2, 1); // 手套的物理伤害提高那一行也摘掉了：按摘下之后的上下文算
      G.execSkill(c2);
      out.plain = [Math.round(h1 - a.hp), Math.round(full), G.relicState.spin];
      P.cast = null;
      RQT.end();
      return out;
    });
    assert(Math.abs(r.per[0] - r.per[1]) <= Math.max(2, r.per[1] * 0.02) && r.spin === 12 && r.ringPulse === 0, '每跳的伤害 / 层数不对：' + JSON.stringify(r));
    assert(Math.abs(r.burst[0] - r.burst[1]) <= Math.max(3, r.burst[1] * 0.02) && r.after === 0, '松手的炸开不对：' + JSON.stringify(r));
    assert(Math.abs(r.plain[0] - r.plain[1]) <= Math.max(2, r.plain[1] * 0.02) && r.plain[2] === 0, '没穿时应照常满额：' + JSON.stringify(r));
    return '每跳 ' + r.per[0] + ' · 12 层炸开 ' + r.burst[0];
  });

  await step('崩势（断岳）：精英被打出破绽时，8 米内的普通怪一起破绽 2.5 秒（停手、受伤 ×1.25），远的和精英自己不算；处决精英时 3 米内破绽中的敌人各吃处决伤害的 35%', async () => {
    const r = await ev(() => {
      RQT.begin('duanyue');
      const C = G.RELIC_MECH.duanyue;
      const el = T.mob('brute', 0, -3, { elite: true });
      const n1 = T.mob('husk', 1.6, -4.2), n2 = T.mob('husk', -1.6, -4.4), far = T.mob('husk', 0, -3 - C.r - 2.5);
      T.fix(0.999);
      const ctx = G.skillCtx('blade');
      el.poise = 1;
      G.hitEnemy(el, ctx, 1, { quiet: true, poise: 50, kb: 0 });
      const out = { broken: el.brokenT > 0, brk: [n1.rqBrk, n2.rqBrk, far.rqBrk || 0, el.rqBrk || 0].map((v) => +v.toFixed(2)), stun: n1.stunT >= C.t - 0.01 };
      let h0 = n1.hp;
      G.hitEnemy(n1, ctx, 1, { quiet: true, kb: 0 });
      const dB = h0 - n1.hp;
      h0 = far.hp;
      G.hitEnemy(far, ctx, 1, { quiet: true, kb: 0 });
      out.taken = +(dB / (h0 - far.hp)).toFixed(3);
      const e0 = el.hp, a0 = n1.hp, f0 = far.hp;
      out.exec = G.execute(el);
      G.debug.step(0.6);
      out.sweep = +((a0 - n1.hp) / (e0 - el.hp)).toFixed(3);
      out.farSweep = Math.round(f0 - far.hp);
      out.want = +(C.sweep * G.POISE.taken).toFixed(3);
      G.debug.step(3);
      out.end = n1.rqBrk || 0;
      RQT.end();
      return out;
    });
    assert(r.broken && r.brk[0] > 2.4 && r.brk[1] > 2.4 && r.brk[2] === 0 && r.brk[3] === 0 && r.stun, '破绽扩散不对：' + JSON.stringify(r));
    assert(Math.abs(r.taken - 1.25) < 0.01, '扩散出来的破绽应受伤 ×1.25：' + r.taken);
    assert(r.exec && Math.abs(r.sweep - r.want) < 0.01 && r.farSweep === 0, '处决横扫不对：' + JSON.stringify(r));
    assert(r.end === 0, '2.5 秒后破绽应结束：' + r.end);
    return '扩散 2 只 · 横扫 ' + r.sweep;
  });

  await step('必然（千目）：暴击率攒进计数器，满 100% 必暴并扣 100（溢出保留）——30% 是第 4 / 7 / 10 击、45% 是第 3 / 5 / 7 / 9 击，和随机数无关；暴击伤害 −15；必暴的招式照旧必暴、不动计数；召唤物照常掷骰', async () => {
    const r = await ev(() => {
      RQT.begin(null);
      const c0 = G.skillCtx('blade');
      G.save.equip.helm = G.rollRelic('qianmu', 50, 0.5);
      G.computeStats();
      const ctx = G.skillCtx('blade');
      const out = { cm: ctx.critMulti - c0.critMulti };
      const seq = (crit, rnd) => { T.fix(rnd); G.relicState.crit = 0; const c = Object.assign({}, ctx, { crit }); const s = []; for (let i = 1; i <= 10; i++) if (G.calcHit(c, 1).crit) s.push(i); return s.join('/'); };
      out.s30 = seq(30, 0);
      out.s30b = seq(30, 0.999);
      out.s45 = seq(45, 0.5);
      G.relicState.crit = 37;
      out.sure = [G.calcHit(Object.assign({}, ctx, { crit: 100 }), 1).crit, G.relicState.crit];
      T.fix(0.999);
      out.minion = G.calcHit(Object.assign({}, ctx, { crit: 99, minion: {} }), 1).crit;
      RQT.end();
      return out;
    });
    assert(r.cm === -15, '暴击伤害应 −15：' + r.cm);
    assert(r.s30 === '4/7/10' && r.s30b === '4/7/10' && r.s45 === '3/5/7/9', '必然的计数不对：' + JSON.stringify(r));
    assert(r.sure[0] === true && r.sure[1] === 37 && r.minion === false, '必暴 / 召唤物不该动计数：' + JSON.stringify(r));
    return '30% → ' + r.s30;
  });

  await step('回旋：飞刃到射程尽头（射程 ×0.8）折返，回程 ×0.6 再中一次去程打过的敌人（靶子共吃 1.6 击）；机炮的子弹和会爆的掷焰不回旋', async () => {
    const r = await ev(() => {
      RQT.begin('huixuan');
      RQT.learn('blade', 0);
      const P = G.player, H = G.RELIC_MECH.huixuan;
      const d = T.openDir(30);
      const m = T.mob('husk', d.x * 5, d.z * 5);
      T.aim(m.x, m.z);
      T.fix(0.999);
      const ctx = G.skillCtx('blade');
      const one = RQT.hit(ctx, 1);
      const t0 = G.state.stats.relicTurns || 0;
      G.execSkill(ctx);
      const p = G.state.projectiles[G.state.projectiles.length - 1];
      const out = { boom: p.boom, life: [+p.life.toFixed(3), +((30 / ctx.sk.speed) * H.range).toFixed(3)], open: Math.round(d.len) };
      G.debug.step(3);
      out.dmg = [Math.round(m.maxHp - m.hp), Math.round(one * (1 + H.back))];
      out.turns = (G.state.stats.relicTurns || 0) - t0;
      out.left = G.state.projectiles.filter((q) => q.owner === 'p').length;
      // 不回旋：机炮、掷焰
      const g = G.spawnProjectile({ owner: 'p', ctx: G.skillCtx('basic_gatling'), x: P.x, z: P.z, dx: 1, dz: 0, speed: 30, life: 0.5 });
      RQT.learn('ember');
      const em = G.spawnProjectile({ owner: 'p', ctx: G.skillCtx('ember'), x: P.x, z: P.z, dx: 1, dz: 0, speed: 20, life: 0.5, explode: 1.9 });
      out.no = [g.boom || 0, em.boom || 0];
      G.debug.step(1);
      RQT.end();
      return out;
    });
    assert(r.boom === 1 && Math.abs(r.life[0] - r.life[1]) < 0.02, '飞刃应标记回旋、射程 ×0.8：' + JSON.stringify(r));
    assert(r.turns === 1 && Math.abs(r.dmg[0] - r.dmg[1]) <= Math.max(3, r.dmg[1] * 0.02) && r.left === 0, '回程应再中一次（×0.6）：' + JSON.stringify(r));
    assert(r.no.join() === '0,0', '机炮 / 掷焰不该回旋：' + r.no);
    return '靶子吃到 ' + r.dmg[0] + '（单击 ×1.6）';
  });

  await step('星雨（陨织袍）：陨火在技能栏上时保留 20% 魔力、不能手动放；每 1.8 秒（吃出手速度）自动落在 12 米内敌人最密处，伤害 ×0.4、半径 ×0.85，不耗魔力', async () => {
    const r = await ev(() => {
      RQT.begin('zhuixing');
      RQT.learn('meteor', 0);
      const P = G.player, F = G.RELIC_MECH.zhuixing;
      const out = { reserve: P.reservePct };
      // 手动：轻点技能键什么也不放
      G.input.tap[0] = 0.3;
      G.debug.step(0.2);
      out.manual = [!!(P.cast && P.cast.id === 'meteor'), P.cds.meteor || 0, G.state.stats.relicMeteors || 0];
      // 一团 3 只（8 米外）+ 一只单独的（4 米）
      const d = T.openDir(12);
      const cx = d.x * 8, cz = d.z * 8;
      const c1 = T.mob('husk', cx, cz), c2 = T.mob('husk', cx + 0.9, cz), c3 = T.mob('husk', cx, cz + 0.9);
      const lone = T.mob('husk', d.z * 4, -d.x * 4);
      for (const o of [c1, c2, c3, lone]) { G.initBuildUp(o); o.buTh = 1e15; } // 不让爆燃掺进陨火的伤害
      T.fix(0.999);
      const ctx = G.skillCtx('meteor');
      const want = RQT.hit(ctx, F.mult);
      const m0 = G.state.stats.relicMeteors || 0;
      G.relicState.metT = 0;
      P.mana = P.maxMana * 0.5;
      const mana0 = P.mana;
      G.debug.step(1 / 60);
      const tg = G.state.telegraphs.filter((t) => t.friendly).pop();
      const gx = (c1.x + c2.x + c3.x) / 3, gz = (c1.z + c2.z + c3.z) / 3;
      out.at = tg ? +Math.hypot(tg.x - gx, tg.z - gz).toFixed(2) : -1;
      out.r = tg ? [+tg.r.toFixed(2), +(ctx.sk.radius * Math.sqrt(ctx.area) * F.area).toFixed(2)] : null;
      out.mana = P.mana >= mana0 - 1e-6;
      G.debug.step(0.9);
      out.dmg = [Math.round(c1.maxHp - c1.hp), Math.round(want)];
      out.lone = Math.round(lone.maxHp - lone.hp);
      const iv = F.iv / ctx.speed;
      G.debug.step(iv * 2 + 0.1);
      out.n = (G.state.stats.relicMeteors || 0) - m0;
      out.iv = +iv.toFixed(2);
      RQT.end();
      return out;
    });
    assert(r.reserve === 20, '应保留 20% 魔力：' + r.reserve);
    assert(r.manual.join() === 'false,0,0', '陨火不该能手动放：' + JSON.stringify(r.manual));
    assert(r.at >= 0 && r.at < 1 && r.r && Math.abs(r.r[0] - r.r[1]) < 0.02 && r.mana, '自动陨火应落在最密处、半径 ×0.85、不耗魔力：' + JSON.stringify(r));
    assert(Math.abs(r.dmg[0] - r.dmg[1]) <= Math.max(2, r.dmg[1] * 0.02) && r.lone === 0, '自动陨火的伤害应 ×0.4：' + JSON.stringify(r));
    assert(r.n === 3, (r.iv * 2 + 0.1).toFixed(2) + ' 秒内应落 3 次（间隔 ' + r.iv + ' 秒）：' + r.n);
    return '间隔 ' + r.iv + ' 秒 · 每发 ' + r.dmg[0];
  });

  await step('电桥：链雷每跳在前后两个目标之间留一道电桥（4 只排一行 → 3 道），最多 8 道（实例化一次 draw call）；站在桥上的敌人每 0.25 秒吃一跳的 18%、累积闪电异常，不放感电电弧；1.5 秒后消失', async () => {
    const r = await ev(() => {
      RQT.begin('dianqiao');
      RQT.learn('arc', 0);
      const P = G.player, D = G.RELIC_MECH.dianqiao;
      const d = T.openDir(16);
      const ms = [4, 7, 10, 13].map((k) => T.mob('husk', d.x * k, d.z * k));
      T.aim(ms[0].x, ms[0].z);
      const ctx = G.skillCtx('arc');
      G.execSkill(ctx);
      const out = { n1: [G.relicState.bridges.length, G.world.relicBridgeCount()] };
      G.execSkill(ctx);
      G.execSkill(ctx);
      out.cap = [G.relicState.bridges.length, G.world.relicBridgeCount()];
      G.relicReset();
      out.cleared = G.world.relicBridgeCount();
      G.clearEnemies();
      // 桥上的靶子（两头没有敌人）：感电中的不放电弧，没感电的累积闪电异常
      const ax = P.x + d.x * 3 + d.z * 2, az = P.z + d.z * 3 - d.x * 2, bx = P.x + d.x * 9 + d.z * 2, bz = P.z + d.z * 9 - d.x * 2;
      const mid = T.mob('husk', (ax + bx) / 2 - P.x, (az + bz) / 2 - P.z);
      const off = T.mob('husk', (ax + bx) / 2 - P.x - d.z * 3, (az + bz) / 2 - P.z + d.x * 3);
      G.initBuildUp(mid);
      mid.shockT = 9;
      T.fix(0.999);
      const tick = RQT.hit(ctx, D.mult);
      const b0 = G.state.stats.bolts || 0;
      G.relicBridges([{ x: P.x, z: P.z }, { x: ax, z: az }, { x: bx, z: bz }], ctx);
      const m2 = T.mob('husk', (ax + bx) / 2 - P.x + d.x * 0.6, (az + bz) / 2 - P.z + d.z * 0.6);
      G.initBuildUp(m2);
      m2.buTh = 1e7; // 阈值放大：一跳就灌满会直接感电、把异常值清零
      G.debug.step(0.3);
      out.build = m2.bu && m2.bu.light > 0 ? 1 : 0;
      G.debug.step(1.4);
      out.ticks = +((mid.maxHp - mid.hp) / tick).toFixed(2);
      out.off = Math.round(off.maxHp - off.hp);
      out.bolts = (G.state.stats.bolts || 0) - b0;
      out.gone = [G.relicState.bridges.length, G.world.relicBridgeCount()];
      RQT.end();
      return out;
    });
    assert(r.n1.join() === '3,3', '4 只排一行应留 3 道电桥：' + r.n1);
    assert(r.cap.join() === '8,8' && r.cleared === 0, '电桥最多 8 道：' + JSON.stringify(r));
    assert(r.ticks >= 4.95 && r.ticks <= 6.05 && r.off === 0 && r.build > 0, '桥上的跳数 / 范围 / 异常不对：' + JSON.stringify(r));
    assert(r.bolts === 0 && r.gone.join() === '0,0', '电桥不该放感电电弧、1.5 秒后应消失：' + JSON.stringify(r));
    return '桥上 ' + r.ticks + ' 跳';
  });

  await step('混相（异变）：火 / 冰 / 雷都灌进同一条混相异常值（三条单独的不涨），满了同时爆燃 + 冻结 + 感电，各 ×0.6；首领只涨一次阈值、重度冰缓；拿着三相之心也不共鸣', async () => {
    const r = await ev(() => {
      RQT.begin('yibian');
      const K = G.RELIC_MECH.yibian.k, BU = G.BUILDUP;
      const ctx = { sk: { w: 0, kb: 0, poise: 0 }, base: { fire: [40, 40], cold: [40, 40], light: [40, 40] }, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: 0, stun: 0, leech: 0, echo: 0, area: 1, bindAil: 0, flame: 0 };
      const e = T.mob('husk', 0, -3), nb = T.mob('husk', 1.5, -3), far = T.mob('husk', 4.5, -3);
      for (const o of [e, nb, far]) { G.initBuildUp(o); o.buTh = 300; }
      const m0 = G.state.stats.mixes || 0;
      G.hitEnemy(e, ctx, 1, { quiet: true, kb: 0 });
      const out = { one: [e.bu.fire, e.bu.cold, e.bu.light, +e.bu.mix.toFixed(3)] };
      G.hitEnemy(e, ctx, 1, { quiet: true, kb: 0 });
      out.fire = [(G.state.stats.mixes || 0) - m0, +e.freeze.toFixed(2), +e.shockT.toFixed(2), +(BU.freeze * K).toFixed(2), +(BU.shock * K).toFixed(2)];
      out.blast = Math.round(nb.maxHp - nb.hp) > 0;
      // 首领（假的：打不死、不动的靶子标成首领）
      const b = T.mob('husk', -3, -3);
      b.isBoss = true;
      G.initBuildUp(b);
      b.buTh = 300;
      for (let i = 0; i < 2; i++) G.hitEnemy(b, ctx, 1, { quiet: true, kb: 0 });
      out.boss = [+b.buGrow.mix.toFixed(2), b.buGrow.fire, b.buGrow.cold, +b.bossChill.toFixed(2), +(BU.bossChill * K).toFixed(2), b.freeze || 0];
      // 三相之心 + 异变：不共鸣
      G.save.equip.weapon = G.rollUnique('sanxiang', 44, 0.5);
      G.computeStats();
      const t = T.mob('husk', 0, -8), t2 = T.mob('husk', 1.2, -8);
      for (const o of [t, t2]) { G.initBuildUp(o); o.buTh = 300; }
      for (let i = 0; i < 2; i++) G.hitEnemy(t, ctx, 1, { quiet: true, kb: 0 });
      out.tri = [G.player.uMech, +(t2.bu.cold || 0).toFixed(3), +(t2.bu.light || 0).toFixed(3), +(t2.bu.fire || 0).toFixed(3)];
      RQT.end();
      return out;
    });
    assert(r.one[0] === 0 && r.one[1] === 0 && r.one[2] === 0 && Math.abs(r.one[3] - (40 / 300) * 3 * 1.27) < 0.01, '应只灌混相：' + JSON.stringify(r.one));
    assert(r.fire[0] === 1 && r.fire[1] === r.fire[3] && r.fire[2] === r.fire[4] && r.blast, '混相灌满应三种一起触发（×0.6）：' + JSON.stringify(r));
    assert(r.boss[0] === 1.5 && r.boss[1] === 1 && r.boss[2] === 1 && r.boss[3] === r.boss[4] && r.boss[5] === 0, '首领：阈值只涨一次、重度冰缓：' + JSON.stringify(r.boss));
    assert(r.tri[0] === 'tri' && r.tri[1] === 0 && r.tri[2] === 0, '异变在身时三相之心不该共鸣：' + JSON.stringify(r.tri));
    return '混相 ' + r.one[3] + ' / 击';
  });

  await step('独骸（骸王冠）：烬骸仆从上限固定 1，伤害 ×2.9（单体秒伤 = 3 具的 0.967）、生命 ×3、横斩带 6 个 / 220°、牵制 5 只、减伤 +15；群聚多给的上限折成 +35% 伤害 / +40% 生命；骸王体型 ×1.5；魂火按普通仆从算', async () => {
    const r = await ev(() => {
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
      RQT.begin(null);
      RQT.learn('thrall', 0);
      const H = G.RELIC_MECH.haiwang;
      const c0 = G.skillCtx('thrall');
      G.save.equip.helm = G.rollRelic('haiwang', 50, 0.5);
      G.computeStats();
      const c1 = G.skillCtx('thrall');
      // 生命按「同一套属性（头盔上的召唤物生命那一行也算）、只关掉独骸」来比
      G.player.relic.haiwang = false;
      const c1b = G.skillCtx('thrall');
      G.computeStats();
      const extra = c0.minion.cap - c0.sk.cap;
      const out = {
        cap: [c0.minion.cap, c1.minion.cap], more: +(c1.more / c0.more).toFixed(4), wantMore: +(H.dmg * (1 + H.perDmg * extra)).toFixed(4),
        life: +(c1.minion.life / c1b.minion.life).toFixed(3), wantLife: +(H.life * (1 + H.perLife * extra)).toFixed(3),
        cleave: c1.minion.cleave, arc: Math.round((c1.minion.arc * 180) / Math.PI), hold: c1.minion.hold, dr: c1.minion.dr - c0.minion.dr, king: !!c1.minion.king,
        dps: extra === 0 ? +(G.skillDps(c1) / G.skillDps(c0)).toFixed(3) : null, soulK: +c1.minion.soulK.toFixed(3),
      };
      // 群聚：多 1 个上限
      if (G.save.supports.indexOf('horde') < 0) G.save.supports.push('horde');
      for (const k in G.save.sockets) G.save.sockets[k] = (G.save.sockets[k] || []).map((s) => (s === 'horde' ? null : s));
      G.save.sockets.thrall = ['horde', null, null];
      G.save.equip.helm = null;
      G.computeStats();
      const h0 = G.skillCtx('thrall');
      G.save.equip.helm = G.rollRelic('haiwang', 50, 0.5);
      G.computeStats();
      const h1 = G.skillCtx('thrall');
      const ex2 = h0.minion.cap - h0.sk.cap;
      out.horde = [ex2 - extra, +(h1.more / h0.more).toFixed(4), +(H.dmg * (1 + H.perDmg * ex2)).toFixed(4), h1.minion.cap];
      // 召唤两次：始终只有 1 具，体型变大
      const P = G.player;
      G.summonMinion('thrall', P.x + 2, P.z);
      G.summonMinion('thrall', P.x - 2, P.z);
      G.relicTick(0.3);
      const ms = G.state.minions.filter((m) => !m.dead && m.skill === 'thrall');
      out.count = ms.length;
      out.big = ms[0] ? [!!ms[0].king, +(ms[0].r / ms[0].r0).toFixed(2), +ms[0].ent.body.scale.x.toFixed(2)] : null;
      RQT.end();
      G.save.bar = bar0;
      return out;
    });
    assert(r.cap[1] === 1 && r.king && Math.abs(r.more - r.wantMore) < 1e-3 && Math.abs(r.life - r.wantLife) < 0.02, '骸王的上限 / 伤害 / 生命不对：' + JSON.stringify(r));
    assert(r.cleave === 6 && r.arc === 220 && r.hold === 5 && r.dr === 15, '骸王的横斩 / 牵制 / 减伤不对：' + JSON.stringify(r));
    assert((r.dps === null || Math.abs(r.dps - 0.967) < 0.01) && r.soulK > 0 && r.soulK <= 1, '单体秒伤应约为 3 具的 0.967、魂火按普通仆从算：' + JSON.stringify(r));
    assert(r.horde[0] === 1 && Math.abs(r.horde[1] - r.horde[2]) < 1e-3 && r.horde[3] === 1, '群聚多给的上限应折成伤害：' + JSON.stringify(r.horde));
    assert(r.count === 1 && r.big && r.big[0] && r.big[1] === 1.5 && r.big[2] === 1.5, '骸王应只有 1 具、体型 ×1.5：' + JSON.stringify(r));
    return '上限 ' + r.cap.join('→') + ' · 伤害 ×' + r.more;
  });

  await step('同殇（同殇甲）：你受到的伤害 30% 转给 10 米内最近的召唤物（按它的减伤结算）、10 米外不转；召唤物最大生命 +25%；召唤物倒下时你回复它最大生命的 8%', async () => {
    const r = await ev(() => {
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
      RQT.begin(null);
      RQT.learn('thrall', 0);
      const P = G.player, T0 = G.RELIC_MECH.tongshang;
      G.save.equip.body = G.rollRelic('tongshang', 50, 0.5);
      G.computeStats();
      const l1 = G.skillCtx('thrall').minion.life;
      P.relic.tongshang = false; // 同一套属性（胸甲上的召唤物生命那一行也算），只关掉同殇来比
      const l0 = G.skillCtx('thrall').minion.life;
      G.computeStats();
      const out = { life: +(l1 / l0).toFixed(3) };
      const m = G.summonMinion('thrall', P.x + 2, P.z);
      m.rising = 0;
      m.res = null;
      m.dr = 0;
      P.god = false;
      P.iframe = 0;
      P.life = P.maxLife;
      const mh = m.hp;
      const pl = P.life;
      const res = P.res.fire || 0;
      const k = (1 - Math.min(90, P.S.lessTaken || 0) / 100) * (1 + Math.max(0, P.S.moreTaken || 0) / 100);
      G.hurtPlayer(100, 'fire', { x: P.x + 1, z: P.z });
      out.p = [+(pl - P.life).toFixed(2), +(Math.max(1, 70 * (1 - res / 100) * k)).toFixed(2)];
      out.m = [+(mh - m.hp).toFixed(2), 30];
      // 10 米外：不转
      m.x = P.x + T0.r + 2;
      P.life = P.maxLife;
      P.iframe = 0;
      const m2 = m.hp;
      G.hurtPlayer(100, 'fire', { x: P.x + 1, z: P.z });
      out.far = [+(P.maxLife - P.life).toFixed(2), +(Math.max(1, 100 * (1 - res / 100) * k)).toFixed(2), +(m2 - m.hp).toFixed(2)];
      // 倒下回血
      P.life = P.maxLife * 0.3;
      const before = P.life;
      const heal = m.maxHp * T0.heal;
      G.hurtMinion(m, 1e9, 'phys');
      out.heal = [+(P.life - before).toFixed(2), +Math.min(heal, P.maxLife - before).toFixed(2)];
      P.god = true;
      RQT.end();
      G.save.bar = bar0;
      return out;
    });
    assert(Math.abs(r.life - 1.25) < 0.02, '召唤物生命应 +25%：' + r.life);
    assert(Math.abs(r.p[0] - r.p[1]) < 0.05 && Math.abs(r.m[0] - r.m[1]) < 0.05, '应转走 30%：' + JSON.stringify(r));
    assert(Math.abs(r.far[0] - r.far[1]) < 0.05 && r.far[2] === 0, '10 米外不该转：' + JSON.stringify(r.far));
    assert(Math.abs(r.heal[0] - r.heal[1]) < 0.05 && r.heal[0] > 0, '召唤物倒下应回血：' + JSON.stringify(r.heal));
    return '你挨 ' + r.p[0] + ' · 召唤物挨 ' + r.m[0];
  });

  await step('随影（招魂带）：翻滚 0.15 秒后召唤物闪到落点周围，各砸一下（各自一击 ×1.5，守像 ×1.0）；翻滚冷却 +15%', async () => {
    const r = await ev(() => {
      const bar0 = T.slotSummon('thrall'); // 召唤物只在技能放在技能栏上时存在
      RQT.begin('zhaohun');
      RQT.learn('thrall', 0);
      const P = G.player, Z = G.RELIC_MECH.zhaohun;
      const d = T.openDir(10);
      const ms = [G.summonMinion('thrall', P.x - d.x * 5, P.z - d.z * 5), G.summonMinion('thrall', P.x - d.x * 5 + d.z, P.z - d.z * 5 - d.x)];
      for (const m of ms) m.rising = 0;
      T.aim(P.x + d.x * 10, P.z + d.z * 10);
      const L = P.moveSpeed * 2.6 * 0.32;
      const lx = P.x + d.x * L, lz = P.z + d.z * L;
      const tgt = T.mob('husk', lx - P.x, lz - P.z);
      T.fix(0.999);
      const one = RQT.hit(ms[0].ctx, Z.mult);
      const c0 = G.state.stats.relicCalls || 0;
      G.dodge();
      const out = { cd: [+P.roll.cdMax.toFixed(4), +(0.9 * (1 - Math.min(90, P.S.dodgeCd || 0) / 100) * (1 + Z.rollCd)).toFixed(4)] };
      const h0 = tgt.hp;
      G.debug.step(0.17);
      out.calls = (G.state.stats.relicCalls || 0) - c0;
      out.near = ms.map((m) => +Math.hypot(m.x - lx, m.z - lz).toFixed(1));
      out.dmg = [Math.round(h0 - tgt.hp), Math.round(one * 2)];
      G.debug.step(0.4);
      RQT.end();
      G.save.bar = bar0;
      return out;
    });
    assert(Math.abs(r.cd[0] - r.cd[1]) < 1e-3, '翻滚冷却应 +15%：' + r.cd);
    assert(r.calls === 1 && r.near.every((v) => v < 3.6), '召唤物应闪到落点周围：' + JSON.stringify(r));
    assert(r.dmg[0] >= r.dmg[1] * 0.98, '落地应各砸一下（×1.5）：' + JSON.stringify(r.dmg));
    return '离落点 ' + r.near.join(' / ') + ' 米 · 砸 ' + r.dmg[0];
  });

  await step('随核（引力核）：黑洞开在你身上并跟着你走；持续 ×0.8、半径 ×0.85、牵引 ×0.75（首领不变）、每跳 ×1.2', async () => {
    const r = await ev(() => {
      RQT.begin('yinli');
      RQT.learn('blackhole', 0);
      const P = G.player, Y = G.RELIC_MECH.yinli;
      const ctx = G.skillCtx('blackhole');
      T.aim(P.x, P.z - 8);
      G.execSkill(ctx);
      const h = G.relicHoleList()[0];
      const R = ctx.sk.radius * Math.sqrt(ctx.area);
      const dur = ctx.sk.dur * (1 + Math.max(0, P.S.holeDur || 0) / 100);
      const out = h ? { at: +Math.hypot(h.x - P.x, h.z - P.z).toFixed(2), R: [+h.R.toFixed(3), +(R * Y.radius).toFixed(3)], dur: [+h.dur.toFixed(3), +(dur * Y.dur).toFixed(3)], mult: h.mult, pull: h.pullMul } : { none: true };
      const d = T.openDir(4);
      T.tp(P.x + d.x * 2, P.z + d.z * 2);
      G.debug.step(0.1);
      out.follow = h ? +Math.hypot(h.x - P.x, h.z - P.z).toFixed(3) : -1;
      G.debug.step(3);
      out.gone = G.relicHoleList().length;
      RQT.end();
      return out;
    });
    assert(!r.none && r.at === 0 && r.follow === 0, '黑洞应开在你身上并跟着你：' + JSON.stringify(r));
    assert(Math.abs(r.R[0] - r.R[1]) < 1e-3 && Math.abs(r.dur[0] - r.dur[1]) < 1e-3 && r.mult === 1.2 && r.pull === 0.75 && r.gone === 0, '随核的数值不对：' + JSON.stringify(r));
    return '半径 ' + r.R[0] + ' · 持续 ' + r.dur[0];
  });

  await step('锁链（渊缚链）：渊缚中的敌人受到你的伤害时，其余渊缚中的（最多 6 个一串）各分到 20%（不暴击、不累积异常），没被缚的不分；分到的不会再分出去；首领不在链上', async () => {
    const r = await ev(() => {
      RQT.begin('yuanfu');
      const U = G.RELIC_MECH.yuanfu;
      const ms = [];
      for (let i = 0; i < 8; i++) ms.push(T.mob('husk', (i % 4) * 1.6 - 2.4, -3 - Math.floor(i / 4) * 1.6));
      const free = T.mob('husk', 3, -7);
      const boss = T.mob('husk', -3, -7);
      boss.isBoss = true;
      boss.bindT = 5;
      for (const m of ms) { G.initBuildUp(m); m.bindT = 5; }
      T.fix(0.999);
      const ctx = G.skillCtx('blade');
      const hp = ms.map((m) => m.hp);
      const c0 = G.state.stats.relicChained || 0;
      G.hitEnemy(ms[0], ctx, 1, { quiet: true, kb: 0 });
      const X = hp[0] - ms[0].hp;
      const got = ms.slice(1).map((m, i) => +((hp[i + 1] - m.hp) / X).toFixed(3)).filter((v) => v > 0);
      const out = { n: got.length, share: got[0], all: got.every((v) => Math.abs(v - U.share) < 0.002), free: free.maxHp - free.hp, boss: boss.maxHp - boss.hp, chained: (G.state.stats.relicChained || 0) - c0 };
      out.build = ms.slice(1).every((m) => !(m.bu.chaos > 0));
      RQT.end();
      return out;
    });
    assert(r.n === 5 && r.all && r.chained === 5, '应有 5 个各分到 20%：' + JSON.stringify(r));
    assert(r.free === 0 && r.boss === 0 && r.build, '没被缚的 / 首领不该分到、分到的不累积异常：' + JSON.stringify(r));
    return '一串 6 个 · 各 ' + r.share;
  });

  await step('渊契图鉴：拾到记进图鉴（最高完美度）、图标马上进预热；保底计数和图鉴存档往返后保留；畸形数据被修正（未知 id 丢、完美度 0–100、计数截到上限）；掉率改版前攒下的计数（旧上限 10 / 8 / 15）截到新上限 2 / 3 / 3，满了的下一次首领击杀必掉；旧存档没有 relic 也照常读（空图鉴）；背包页列出 13 + 2 件（巅峰的两件 D5 接进来）', async () => {
    const r = await ev(() => {
      RQT.begin(null);
      const P = G.player, KEY = 'cinder-abyss-save-v1';
      const keep = localStorage.getItem(KEY);
      G.save.relic = { found: {}, best: {}, pity: {} };
      G.save.bag.length = 0;
      const it = G.rollRelic('qianmu', 40, 1);
      G.spawnLoot('item', it, P.x + 1, P.z);
      const loot = G.state.loot[G.state.loot.length - 1];
      const ok = G.pickup(loot);
      const out = { ok, found: !!G.save.relic.found.qianmu, best: G.save.relic.best.qianmu, warm: G.icons.rqWarm().indexOf('qianmu') >= 0 };
      G.save.relic.pity.panzhong = 1;
      G.save.relic.pity.seal = 2;
      G.persist();
      G.loadSave();
      out.round = [!!G.save.relic.found.qianmu, G.save.relic.best.qianmu, G.save.relic.pity.panzhong, G.save.relic.pity.seal].join();
      // 畸形数据
      const raw = JSON.parse(localStorage.getItem(KEY));
      raw.relic = { found: { qianmu: true, bogus: true, haiwang: 1 }, best: { qianmu: 250, nope: 50, yinli: -4 }, pity: { panzhong: 99, seal: -3, haiwang: 'x', bogus: 4, yinli: 3.7 } };
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      const s = G.save.relic;
      out.bad = T.canon(s);
      // 掉率改版前的存档：首领 7 / 2 / 1、异兆 6、烈印 12 → 截到 2 / 2 / 1、3、3；满了的下一次必掉并清零，没满的照常 +1
      raw.relic = { found: {}, best: {}, pity: { panzhong: 7, huixuan: 2, nuchao: 1, dianqiao: 6, seal: 12 } };
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      const cp = G.save.relic.pity;
      out.carry = [cp.panzhong, cp.huixuan, cp.nuchao, cp.dianqiao, cp.seal].join();
      T.fix(0.999);
      out.carryDrop = [G.relicBossRoll('golem', 1), G.relicBossRoll('warden', 1), cp.panzhong || 0, cp.nuchao].join();
      T.unfix();
      // 旧存档：没有 relic，背包里也没有渊契
      delete raw.relic;
      raw.bag = [];
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      out.old = T.canon(G.save.relic);
      // 背包页：13 + 巅峰 2 = 15 行（D5 把熄烛冠 / 双生坠接进图鉴）、拾到 0
      G.ui.open('inv');
      out.rows = document.querySelectorAll('.cx-row.rq').length;
      out.title = /渊契图鉴/.test(T.bodyText()) && /已拾到 0 \/ 15/.test(T.bodyText());
      G.ui.close();
      if (keep) localStorage.setItem(KEY, keep);
      else localStorage.removeItem(KEY);
      G.loadSave();
      RQT.end();
      return out;
    });
    assert(r.ok && r.found && r.best === 100 && r.warm, '拾取应记进图鉴、图标进预热：' + JSON.stringify(r));
    assert(r.round === 'true,100,1,2', '图鉴 / 保底存档往返不对：' + r.round);
    assert(r.bad === '{"best":{"qianmu":100},"found":{"qianmu":true},"pity":{"panzhong":2,"yinli":2}}', '畸形数据没修好：' + r.bad);
    assert(r.carry === '2,2,1,3,3' && r.carryDrop === 'panzhong,,0,2', '旧存档的保底计数应截到新上限、满了下一次必掉：' + JSON.stringify(r));
    assert(r.old === '{"best":{},"found":{},"pity":{}}', '旧存档应是空图鉴：' + r.old);
    assert(r.rows === 15 && r.title, '背包页应列出 13 + 2 件渊契：' + JSON.stringify(r));
    return '往返 ' + r.round;
  });

  await step('渊契图标：rqIcons() 里每个键都画得出来（各不相同）、物品图标键是 it-rq-<id>；图标总数 = 原有的 + 拾到过的渊契（没拾到的不进预热）', async () => {
    const r = await ev(() => {
      const ids = G.icons.rqIcons();
      const urls = ids.map((id) => G.icons.url('it-rq-' + id));
      const keys = G.icons.keys();
      const warm = G.icons.rqWarm();
      const base = G.SLOTS.reduce((n, sl) => n + G.BASES[sl].reduce((m, b) => m + b.names.length, 0), 0) + G.icons.uqIcons().length + G.CUR_IDS.length + Object.keys(G.SKILLS).length + Object.keys(G.SUPPORTS).length + 6 + 1;
      // D5：13 件 + 巅峰 2 件（G.RELIC_CODEX）
      return {
        n: ids.length, same: ids.slice().sort().join() === G.RELIC_CODEX.slice().sort().join(), bad: ids.filter((id, i) => !/^data:image\/png;base64,/.test(urls[i]) || urls[i].length < 1500), uniq: new Set(urls).size,
        key: G.icons.itemKey(G.rollRelic('yinli', 30)), rqKeys: keys.filter((k) => k.indexOf('it-rq-') === 0).length, warm: warm.length, total: [keys.length, base + warm.length],
      };
    });
    assert(r.n === 15 && r.same && r.bad.length === 0 && r.uniq === 15, '渊契图标没画全或重复：' + JSON.stringify(r));
    assert(r.key === 'it-rq-yinli' && r.rqKeys === r.warm && r.total[0] === r.total[1], '图标键 / 总数不对：' + JSON.stringify(r));
    return r.n + ' 个渊契图标 · 预热里 ' + r.warm + ' 个';
  });

  // ================================================================== 渊印（D3：区域词缀，层级 ≥ 1 进区前择印）
  // 放在「localStorage 不可用」那一步之前：那一步把存储整个弄坏，之后读不了存档
  await step('渊印·生成：层级 1 / 2 / 3 各 1000 个种子，条数 / 权重 W / 危险预算 / 互斥都合规，同一个 sealSeq 结果相同', async () => {
    const r = await ev(() => {
      const out = { bad: [], W: {}, n: {}, maxDz: {} };
      const bars = [['cleave', 'ember', null, null], ['vortex', 'nova', 'blackhole', 'thrall']];
      const t0 = performance.now();
      let rolls = 0;
      for (const tier of [1, 2, 3]) {
        const T = G.sealTierDef(tier);
        out.maxDz[tier] = 0;
        for (let seq = 0; seq < 1000; seq++) {
          const zi = seq % 5, bar = bars[seq % 2];
          const seals = G.rollSeals(zi, tier, seq, bar);
          rolls++;
          if (seals.length !== 3 || seals.some((s, g) => s.g !== g)) out.bad.push('三枚印不全 ' + tier + '/' + seq);
          if (JSON.stringify(G.rollSeals(zi, tier, seq, bar)) !== JSON.stringify(seals)) out.bad.push('同种子结果不同 ' + seq);
          for (const s of seals) {
            const ids = s.mods.map((m) => m.id), n = ids.length;
            const nMin = Math.max(T.n[0], s.g === 2 ? T.minN3 : 0), nMax = T.n[1] + (s.g === 2 ? 1 : 0);
            const W = G.sealW(s, bar), dz = G.sealDanger(s), rage = ids.filter((id) => G.SEAL_MODS[id].rage).length;
            const dead = s.mods.filter((m) => G.sealModW(m, bar) === 0).length;
            const tint = s.mods.filter((m) => m.id === 'tint');
            out.maxDz[tier] = Math.max(out.maxDz[tier], dz);
            const key = tier + ':' + s.g;
            out.W[key] = out.W[key] || {};
            out.W[key][W] = (out.W[key][W] || 0) + 1;
            if (n < nMin || n > nMax) out.bad.push('条数 ' + key + ' ' + n);
            if (W !== s.W || W < T.W[s.g][0] || W > T.W[s.g][1]) out.bad.push('W ' + key + ' ' + W);
            if (dz > T.budget + 1e-9) out.bad.push('预算 ' + key + ' ' + dz);
            if (rage > 2 || dead > 1 || new Set(ids).size !== n || tint.length > 1) out.bad.push('互斥 ' + ids.join());
            if (tint.length && (tint[0].el === G.ZONES[zi].elem || !G.SEAL_TINT[tint[0].el])) out.bad.push('焚染元素 ' + tint[0].el);
          }
        }
      }
      out.ms = +((performance.now() - t0) / rolls).toFixed(3);
      // 表：20 条（怪物侧 14、玩家侧 6），每条都有名字、单字、权重 1–2、dmgK ≥ 1
      const ids = G.SEAL_MOD_IDS;
      out.nMods = ids.length;
      out.side = ids.filter((id) => G.SEAL_MODS[id].side === 'mob').length + '/' + ids.filter((id) => G.SEAL_MODS[id].side === 'player').length;
      out.tableOk = ids.every((id) => { const d = G.SEAL_MODS[id]; return d.name && (d.glyph || id === 'tint') && (d.w === 1 || d.w === 2) && d.dmgK >= 1 && d.p; });
      return out;
    });
    assert(r.nMods === 20 && r.side === '14/6' && r.tableOk, '印纹表不对：' + JSON.stringify({ n: r.nMods, side: r.side, ok: r.tableOk }));
    assert(!r.bad.length, '掷出来的印不合规：' + r.bad.slice(0, 8).join(' | '));
    // 每一档的目标 W 区间都能掷到（包括上限 7 / 9 / 10）
    for (const [k, lo, hi] of [['1:0', 2, 3], ['1:1', 4, 5], ['1:2', 6, 7], ['2:0', 2, 3], ['2:1', 4, 6], ['2:2', 7, 9], ['3:0', 3, 4], ['3:1', 5, 7], ['3:2', 8, 10]]) {
      for (let w = lo; w <= hi; w++) assert(r.W[k] && r.W[k][w] > 0, '档 ' + k + ' 掷不到 W ' + w + '：' + JSON.stringify(r.W[k]));
    }
    // 「单次不到 2 ms」的耗时断言在 test:timed 里（计时｜渊印·生成）
    return 'W 分布 ' + JSON.stringify(r.W['2:2']) + '（层级 2 烬印），最高危险度 ' + [1, 2, 3].map((t) => r.maxDz[t].toFixed(3)).join(' / ') + '，每次 ' + r.ms + ' ms';
  });

  await step('渊印·应用：厚躯 + 凶戾的普通怪生命 / 伤害；群首精英 ≤ 8；殁爆 0.9 s 预警、上限 8、伤害 70%、叠在一起只算一下；幽晦改雾和暖光、下一区复位；领群者每群恰好一只', async () => {
    const r = await ev(() => {
      const out = {}, St = G.state, P = G.player;
      const keep = { zi: St.zoneIdx, tier: St.tier, maxTier: G.save.maxTier };
      G.save.maxTier = Math.max(2, G.save.maxTier);
      const seal = (ids, el) => ({ g: 2, mods: ids.map((id) => (id === 'tint' ? { id, el: el || 'cold' } : { id })) });
      // 厚躯 + 凶戾：逐只核对（生命 = 基础 × 0.55 × 1.35，伤害 × 1.2；首领 +20% / +15%）
      G.enterZone(2, 1, seal(['tough', 'fierce']));
      out.bad = [];
      for (const e of St.enemies) {
        const lv = e.level;
        if (e.isBoss) {
          if (e.maxHp !== Math.round(e.def.hp * G.hpScale(lv) * 1.2) || Math.abs(e.dmg - e.def.dmg * G.dmgScale(lv) * 1.15) > 1e-6) out.bad.push('首领 ' + e.maxHp);
        } else if (!e.elite) {
          if (e.maxHp !== Math.max(1, Math.round(e.def.hp * G.hpScale(lv) * 0.55 * 1.35)) || Math.abs(e.dmg - e.def.dmg * G.dmgScale(lv) * 1.2) > 1e-6) out.bad.push(e.type + ' ' + e.maxHp);
        }
      }
      out.n = St.enemies.length;
      // 群首：五个区各 4 个种子，精英数 ≥ 素印、≤ 上限，平均多出来的 > 0
      out.el = [];
      let more = 0;
      for (let z = 0; z < 5; z++) for (let s = 0; s < 4; s++) {
        G.debug.zoneSeed(7000 + z * 13 + s);
        G.enterZone(z, 1);
        const a = St.enemies.filter((e) => e.elite).length;
        G.enterZone(z, 1, seal(['elites']));
        const b = St.enemies.filter((e) => e.elite).length;
        out.el.push(a + '→' + b);
        more += b - a;
        const cap = (G.SEAL_ELITE_CAP && G.SEAL_ELITE_CAP[G.ZONES[z].id]) || G.SEAL_MODS.elites.p.cap;
        if (b < a || b > cap) out.bad.push('群首 ' + G.ZONES[z].id + ' ' + a + '→' + b);
      }
      G.debug.zoneSeed(null);
      out.more = more / 20;
      // 领群：每群（≥ 2 只）恰好一只领群者，有精英时是精英
      G.enterZone(3, 1, seal(['aura', 'burst']));
      const packs = {};
      for (const e of St.enemies) if (e.pack != null && (e.horde || e.elite)) (packs[e.pack] = packs[e.pack] || []).push(e);
      out.packBad = 0;
      out.packs = 0;
      for (const k in packs) {
        const L = packs[k].filter((e) => e.leader);
        if (packs[k].length < 2) { if (L.length) out.packBad++; continue; }
        out.packs++;
        if (L.length !== 1 || (packs[k].some((e) => e.elite) && !L[0].elite)) out.packBad++;
      }
      // 殁爆：在空地上刷 12 只游魂杀掉，预警圈恰好 8 个、0.9 s、半径 1.8；站在圈里吃一下 = 它一击的 70%（不带焚染）
      T.arena();
      const vic = [];
      for (let i = 0; i < 12; i++) vic.push(G.spawnMob('husk', P.x + 3 + (i % 4) * 0.7, P.z + 3 + Math.floor(i / 4) * 0.7, 30, { awake: false }));
      const hit = vic[0].dmgBase;
      for (const e of vic) G.killEnemy(e);
      const tb = St.telegraphs.filter((t) => t.sealBurst);
      out.burst = { n: tb.length, dur: tb[0] && tb[0].dur, r: tb[0] && tb[0].r, k: tb[0] && +(tb[0].burstDmg / hit).toFixed(3) };
      // 站进第一个圈（和旁边几个圈叠着）：0.85 s 时还没炸，0.95 s 时炸了；同时炸开的几个只算一下
      const t0 = tb[0];
      T.tp(t0.x, t0.z);
      P.iframe = 0;
      P.god = false;
      P.life = P.maxLife = 1e6;
      G.player.armour = 0;
      for (let i = 0; i < 51; i++) G.tick(1 / 60);
      out.before = St.telegraphs.filter((t) => t.sealBurst).length;
      const l0 = P.life;
      for (let i = 0; i < 6; i++) G.tick(1 / 60);
      out.after = St.telegraphs.filter((t) => t.sealBurst).length;
      out.took = l0 - P.life;
      out.hit = hit;
      G.computeStats();
      P.life = P.maxLife;
      // 幽晦：雾 17 / 38、暖光 12；进下一区复位 22 / 52 / 16
      G.enterZone(0, 1, seal(['gloom']));
      out.gloom = G.world.gloomInfo();
      G.enterZone(0, 1);
      out.gloomOff = G.world.gloomInfo();
      G.save.maxTier = keep.maxTier;
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    assert(!r.bad.length, '数值不对：' + r.bad.slice(0, 6).join(' | '));
    assert(r.more > 0, '群首应多出精英：' + r.el.join(' '));
    assert(r.packs > 4 && r.packBad === 0, '领群者不对：' + JSON.stringify({ packs: r.packs, bad: r.packBad }));
    assert(r.burst.n === 8 && Math.abs(r.burst.dur - 0.9) < 1e-9 && r.burst.r === 1.8 && r.burst.k === 0.7, '殁爆预警不对：' + JSON.stringify(r.burst));
    assert(r.before >= 1 && r.after < r.before && r.took > 0 && r.took <= r.hit * 0.7 + 1, '殁爆该在 0.9 s 时炸、叠在一起也只扣一下（它一击的 70%）：' + JSON.stringify({ b: r.before, a: r.after, took: r.took, hit: r.hit }));
    assert(r.gloom.near === 17 && r.gloom.far === 38 && r.gloom.lamp === 12 && r.gloom.tag === 18, '幽晦没有改雾 / 暖光：' + JSON.stringify(r.gloom));
    assert(r.gloomOff.near === 22 && r.gloomOff.far === 52 && r.gloomOff.lamp === 16 && r.gloomOff.tag === 0, '幽晦进下一区没复位：' + JSON.stringify(r.gloomOff));
    return '精英 ' + r.el.slice(0, 5).join(' ') + '…（平均 +' + r.more.toFixed(2) + '），领群 ' + r.packs + ' 群，殁爆一下 ' + Math.round(r.took) + ' / 一击 ' + Math.round(r.hit);
  });

  await step('渊印·奖励：dropLoot 各掷 40000 次，物品 / 通货件数按 1 + Q、稀有占比按 1 + R 变化，宝石不变；击杀经验 × (1 + X)；三项都有上限', async () => {
    const r = await ev(() => {
      const out = {}, St = G.state;
      const keep = { zi: St.zoneIdx, tier: St.tier, maxTier: G.save.maxTier, sp: G.spawnLoot, gx: G.gainXp };
      G.save.maxTier = Math.max(1, G.save.maxTier);
      const count = (e, n) => {
        const c = { item: 0, cur: 0, gem: 0, rare: 0 };
        G.spawnLoot = (kind, data) => {
          if (kind === 'item') { c.item++; if (data.rarity === 2) c.rare++; }
          else if (kind === 'cur') c.cur++;
          else c.gem++;
          return null;
        };
        for (let i = 0; i < n; i++) G.dropLoot(e);
        G.spawnLoot = keep.sp;
        return c;
      };
      const mob = { level: 30, x: 0, z: 0, def: G.MOBS.husk, horde: true, hordeK: 1 };
      const elite = { level: 30, elite: true, x: 0, z: 0 };
      const seal5 = { g: 1, mods: [{ id: 'tough' }, { id: 'ailRes' }, { id: 'mend' }] }; // W 5：Q 25%、R 30%、X 20%
      const sups = G.save.supports.slice();
      if (!G.save.supports.length) G.save.supports.push('multi'); // 不让「首颗辅助」的保底混进来
      G.enterZone(1, 1);
      out.p = count(mob, 40000);
      out.pe = count(elite, 20000);
      G.enterZone(1, 1, seal5);
      out.W = G.runSealW();
      out.mods = JSON.parse(JSON.stringify(G.runMods));
      out.s = count(mob, 40000);
      out.se = count(elite, 20000);
      // 经验：同一只怪，素印 / W 5 各杀一次
      let got = 0;
      G.gainXp = (v) => { got += v; };
      const kx = (sealed) => {
        G.enterZone(1, 1, sealed ? seal5 : undefined);
        const e = G.state.enemies.find((q) => q.horde && !q.elite && !q.dead);
        const want = G.killXp(e, G.save.level);
        got = 0;
        G.killEnemy(e);
        return got / want;
      };
      out.x0 = kx(false);
      out.x5 = kx(true);
      G.gainXp = keep.gx;
      out.cap = G.sealReward(30);
      G.save.supports = sups;
      G.save.maxTier = keep.maxTier;
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    const near = (a, b) => Math.abs(a / b - 1) <= 0.15;
    assert(r.W === 5 && r.mods.qty === 0.25 && Math.abs(r.mods.rar - 0.3) < 1e-9 && Math.abs(r.mods.xp - 0.2) < 1e-9, 'W 5 的奖励不对：' + JSON.stringify(r.mods));
    assert(near(r.s.item / r.p.item, 1.25) && near(r.s.cur / r.p.cur, 1.25), '普通怪的物品 / 通货应 ×1.25：' + JSON.stringify({ p: r.p, s: r.s }));
    assert(near(r.se.item / r.pe.item, 1.25) && near(r.se.cur / r.pe.cur, 1.25), '精英的件数应 ×1.25：' + JSON.stringify({ p: r.pe, s: r.se }));
    assert(near(r.s.gem / r.p.gem, 1) && near(r.se.gem / r.pe.gem, 1), '宝石不该吃数量：' + JSON.stringify({ p: r.p.gem, s: r.s.gem, pe: r.pe.gem, se: r.se.gem }));
    assert(near(r.se.rare / r.se.item / (r.pe.rare / r.pe.item), 1.3), '稀有占比应 ×1.3：' + JSON.stringify({ p: r.pe, s: r.se }));
    assert(Math.abs(r.x0 - 1) < 1e-6 && Math.abs(r.x5 - 1.2) < 1e-6, '击杀经验应 × (1 + X)：' + JSON.stringify({ x0: r.x0, x5: r.x5 }));
    assert(r.cap.qty === 0.45 && r.cap.rar === 0.6 && r.cap.xp === 0.35, '上限不对：' + JSON.stringify(r.cap));
    return '物品 ' + r.p.item + ' → ' + r.s.item + '，精英稀有 ' + (r.pe.rare / r.pe.item).toFixed(3) + ' → ' + (r.se.rare / r.se.item).toFixed(3) + '，宝石 ' + r.p.gem + ' → ' + r.s.gem;
  });

  await step('渊印·持久化：选印 → 存档 → 读档重进是同一枚印、不弹面板；倒下重生保留；换区清掉；坏数据丢掉、W 重算；旧存档 run 为空', async () => {
    const r = await ev(() => {
      const out = {}, St = G.state, KEY = 'cinder-abyss-save-v1';
      const keepTxt = localStorage.getItem(KEY);
      const keep = { zi: St.zoneIdx, tier: St.tier };
      G.save.maxTier = Math.max(1, G.save.maxTier);
      const seals = G.rollSeals(2, 1);
      out.seq0 = G.save.sealSeq;
      out.same = JSON.stringify(G.rollSeals(2, 1)) === JSON.stringify(seals); // 开关面板不换印
      G.enterZone(2, 1, seals[2]);
      out.name = G.sealName(St.run.seal);
      out.seq1 = G.save.sealSeq;
      out.changed = JSON.stringify(G.rollSeals(2, 1)) !== JSON.stringify(seals); // 真正进区之后换一批
      G.persist();
      const s2 = G.loadSave();
      G.enterZone(s2.lastZone, s2.tier, 'resume'); // main.js 读档时就是这样进的
      out.resumed = G.sealName(St.run.seal);
      out.resumeW = St.run.seal && St.run.seal.W;
      out.seq2 = G.save.sealSeq;
      out.panel = G.ui.isOpen();
      // 倒下重生
      G.respawn();
      out.respawn = G.sealName(St.run.seal);
      // 换区：清掉
      G.enterZone(3, 1);
      out.after = St.run.seal;
      out.mods = Object.keys(G.runMods).sort().join();
      // 坏数据：未知 id、重复、焚染元素不对、W 乱写
      G.persist();
      const raw = JSON.parse(localStorage.getItem(KEY));
      raw.run = { zone: raw.lastZone, tier: raw.tier, seq: 3, seal: { g: 9, W: 99, mods: [{ id: 'fierce' }, { id: 'nope' }, { id: 'fierce' }, { id: 'tint', el: 'chaos' }, { id: 'tough' }] } };
      localStorage.setItem(KEY, JSON.stringify(raw));
      out.dirty = JSON.stringify(G.loadSave().run);
      raw.run.zone = (raw.lastZone + 1) % 5; // 区域对不上：丢掉
      localStorage.setItem(KEY, JSON.stringify(raw));
      out.mismatch = G.loadSave().run;
      // 旧存档：没有这两项
      delete raw.run;
      delete raw.sealSeq;
      localStorage.setItem(KEY, JSON.stringify(raw));
      const s3 = G.loadSave();
      out.old = { run: s3.run, seq: s3.sealSeq };
      if (keepTxt) localStorage.setItem(KEY, keepTxt);
      else localStorage.removeItem(KEY);
      G.loadSave();
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    assert(r.same && r.changed && r.seq1 === r.seq0 + 1, '面板的三枚印应在真正进区后才换：' + JSON.stringify(r));
    assert(r.resumed === r.name && r.resumeW > 0 && r.seq2 === r.seq1 && !r.panel, '读档后应接着同一枚印：' + JSON.stringify(r));
    assert(r.respawn === r.name, '倒下重生应保留渊印：' + r.respawn);
    assert(r.after === null && r.mods === 'W,lie,qty,rar,xp', '换区应清掉渊印：' + JSON.stringify(r));
    assert(r.dirty === '{"zone":3,"tier":1,"seq":3,"seal":{"g":2,"mods":[{"id":"fierce"},{"id":"tough"}],"W":4}}', '坏数据没洗干净：' + r.dirty);
    assert(r.mismatch === null && r.old.run === null && r.old.seq === 0, '对不上的 / 旧存档 run 应为空：' + JSON.stringify(r));
    return r.name + '，sealSeq ' + r.seq0 + ' → ' + r.seq1;
  });

  await step('渊印·界面：层级 1 点进入弹择印面板（4 张卡、素印在第一张）、数字键选印；层级 0 不弹；HUD 小签条数对、悬停有说明；地图页写着这次的印；层级 2 的卡片写烛芯几率', async () => {
    const keep = await ev(() => {
      const k = { zi: G.state.zoneIdx, tier: G.state.tier, maxTier: G.save.maxTier };
      G.save.maxTier = Math.max(1, G.save.maxTier);
      G.ui.close();
      return k;
    });
    await page.keyboard.press('KeyM');
    await until(() => G.ui.isOpen() && document.querySelector('[data-act="tier"][data-tier="1"]'));
    await page.click('[data-act="tier"][data-tier="1"]');
    await page.click('[data-act="enter"][data-zone="0"]'); // 第一个区域总是开着
    const a = await ev(() => {
      const cards = [...document.querySelectorAll('.seal-pick .seal-card')];
      return { n: cards.length, first: cards[0] && cards[0].classList.contains('plain'), names: cards.map((c) => c.querySelector('.sk-name').textContent), open: G.ui.isOpen(), frag: document.querySelectorAll('.seal-pick .sk-frag').length };
    });
    await page.keyboard.press('Digit3'); // 第三张 = 深印
    await frames(2);
    const b = await ev(() => ({
      open: G.ui.isOpen(), zi: G.state.zoneIdx, tier: G.state.tier, name: G.sealName(G.state.run.seal), g: G.state.run.seal && G.state.run.seal.g,
      chips: document.querySelectorAll('#seal-chips .sc').length, mods: G.state.run.seal ? G.state.run.seal.mods.length : -1,
    }));
    // 悬停第一个小签：弹出这条印纹的说明
    const pt = await ev(() => T.rect('#seal-chips .sc'));
    await page.mouse.move(pt.x, pt.y);
    await frames(2);
    const tip = await ev(() => { const t = document.getElementById('tip'); return t && t.classList.contains('on') ? t.innerText : ''; });
    await page.mouse.move(700, 450);
    // 地图页上写着这次的印；层级 0 点进入不弹面板
    await page.keyboard.press('KeyM');
    await until(() => G.ui.isOpen());
    const mapTxt = await ev(() => T.bodyText());
    await page.click('[data-act="tier"][data-tier="0"]');
    await page.click('[data-act="enter"][data-zone="0"]');
    await frames(2);
    const c = await ev(() => ({ open: G.ui.isOpen(), pick: !!document.querySelector('.seal-pick'), zi: G.state.zoneIdx, tier: G.state.tier, seal: G.state.run.seal, chips: document.querySelectorAll('#seal-chips .sc').length }));
    // 层级 2：每张卡写这一档的烛芯几率（层级 1 不写）；Esc 返回，不进区
    await ev(() => (G.save.maxTier = Math.max(2, G.save.maxTier)));
    await page.keyboard.press('KeyM');
    await until(() => G.ui.isOpen() && document.querySelector('[data-act="tier"][data-tier="2"]'));
    await page.click('[data-act="tier"][data-tier="2"]');
    await page.click('[data-act="enter"][data-zone="0"]');
    await until(() => document.querySelector('.seal-pick .seal-card'));
    const d = await ev(() => [...document.querySelectorAll('.seal-pick .seal-card')].map((el) => (el.querySelector('.sk-frag') || { textContent: '' }).textContent).join('/'));
    await page.keyboard.press('Escape');
    await frames(2);
    await ev(() => G.ui.close());
    await ev((k) => { G.save.maxTier = k.maxTier; G.enterZone(k.zi, k.tier); }, keep);
    assert(a.open && a.n === 4 && a.first && a.names[0] === '素印' && /^浅印/.test(a.names[1]) && /^深印/.test(a.names[2]) && /^烬印/.test(a.names[3]), '择印面板不对：' + JSON.stringify(a));
    assert(!b.open && b.zi === 0 && b.tier === 1 && b.g === 1 && b.name === a.names[2], '数字键 3 应选深印进区：' + JSON.stringify(b));
    assert(b.chips === b.mods + 1, 'HUD 小签条数不对：' + JSON.stringify(b));
    assert(tip.length > 8 && /印纹/.test(tip), '小签悬停没有说明：' + tip);
    assert(mapTxt.indexOf('本次进区') >= 0 && mapTxt.indexOf(b.name) >= 0, '地图页没写这次的印');
    assert(!c.open && !c.pick && c.zi === 0 && c.tier === 0 && c.seal === null && c.chips === 0, '层级 0 不该弹面板 / 有小签：' + JSON.stringify(c));
    assert(a.frag === 0 && d === '烛芯 40%/烛芯 40%/烛芯 70%/烛芯 100%', '择印卡片的烛芯几率不对（层级 1 不写，层级 2 素印 / 浅印 / 深印 / 烬印）：' + a.frag + ' ' + d);
    return a.names.join(' / ') + '；小签 ' + b.chips + ' 个';
  });

  await step('渊印·素印：G.enterZone(z, t) 不带印时没有任何印纹效果（保护「经验」那一步）', async () => {
    const r = await ev(() => {
      const St = G.state, out = { bad: [] };
      const keep = { zi: St.zoneIdx, tier: St.tier };
      for (const [z, t] of [[0, 0], [2, 1], [4, 2]]) {
        G.enterZone(z, t);
        if (St.run.seal !== null || G.runMods.W !== 0 || Object.keys(G.runMods).length !== 5) out.bad.push('runMods ' + z + '/' + t);
        for (const e of St.enemies) {
          const base = e.isBoss ? Math.round(e.def.hp * G.hpScale(e.level)) : Math.max(1, Math.round(e.def.hp * G.hpScale(e.level) * (e.elite ? 4.5 : 0.55)));
          if (e.maxHp !== base || e.leader || e.speed !== e.def.speed) out.bad.push(e.type + ' ' + e.maxHp + '/' + base);
        }
        const g = G.world.gloomInfo();
        if (g.near !== 22 || g.lamp !== 16) out.bad.push('雾');
      }
      out.xp = G.killXp({ level: 20, def: G.MOBS.husk }, 20) === G.mobXp(20);
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    assert(!r.bad.length && r.xp, '素印不该有任何效果：' + r.bad.slice(0, 6).join(' | '));
  });

  // ------------------------------------------------------------------ D4 异兆（设计稿 §10）
  // 页面里共用的小工具（每一步自己装一遍，单独跑某一步也行）：进区并强制放一种异兆、推进模拟、清房间
  const encKit = () =>
    ev(() => {
      const S = G.state, P = G.player;
      window.EK = {
        put(kind, z, t, seed) {
          for (let k = 0; k < 8; k++) {
            G.debug.zoneSeed(seed === undefined ? 900 + k * 13 : seed + k);
            G.enterZone(z, t);
            G.rollEncounters(S.zone, t, [kind]);
            if (S.enc.length) break;
          }
          G.debug.zoneSeed(null);
          T.clearLoot();
          P.god = true;
          P.iframe = 0;
          return S.enc[0] || null;
        },
        step(sec, fn) {
          const n = Math.round(sec * 60);
          for (let i = 0; i < n; i++) {
            G.tick(1 / 60);
            if (fn && fn(i)) return i;
          }
          return n;
        },
        clearRoom(enc) {
          for (const e of enc.roomMobs || []) if (!e.dead) G.killEnemy(e);
        },
        kill(list) {
          for (const e of list) if (!e.dead) G.killEnemy(e);
        },
        // 收起玩家这边会自己出手的伤害来源：召唤物（换区会跟过来）、自动召唤、技能栏上的光环（每隔一阵打身边所有怪）、
        // 前面步骤留下的按住的键鼠（右键按着就一直挥武器）。要量「只有异兆在打怪」的步骤用；返回还原函数
        quiet() {
          const auto = Object.assign({}, G.save.autoSummon || {}), bar = G.save.bar.slice();
          for (const k in G.save.autoSummon || {}) G.save.autoSummon[k] = false;
          G.clearMinions();
          G.save.bar = bar.map((id) => (id && G.SKILLS[id] && G.SKILLS[id].kind === 'aura' ? null : id));
          G.computeStats();
          for (const k in G.input.keys) G.input.keys[k] = false;
          G.input.mouse.b[0] = G.input.mouse.b[1] = G.input.mouse.b[2] = false;
          P.cast = null;
          return () => {
            Object.assign(G.save.autoSummon || {}, auto);
            G.save.bar = bar;
            G.computeStats();
          };
        },
        items: () => S.loot.filter((l) => l.kind === 'item').length,
        done() {
          P.god = false;
          G.debug.noEnc = false;
          G.enterZone(0, 0);
          T.clearLoot();
        },
      };
    });

  await step('异兆选址：5 区 × 20 个种子 × 8 种，点位都合规（离起点 ≥ 12 m、不进场地、离场地门 ≥ 18 m、不在灼烧 / 薄冰上、彼此 ≥ 25 m）；找不到点位时换下一种、不报错', async () => {
    await encKit();
    const r = await ev(() => {
      const W = G.world, S = G.state, E = G.ENC, bad = [], n = {};
      let placed = 0, msMax = 0;
      for (let z = 0; z < 5; z++) {
        for (let s = 1; s <= 20; s++) {
          G.debug.zoneSeed(3000 + z * 101 + s * 7);
          G.enterZone(z, 1);
          msMax = Math.max(msMax, S.zone.ms.enc); // 正常进区（掷 1–2 个）的选址耗时
          const zone = S.zone, a = zone.arena;
          // 每种单独放一次（数能不能放上），再 8 种一起放（间距约束最紧；大房间点位被前几种占掉时后面的换不到，属正常）
          const lists = G.ENC_IDS.map((k) => {
            const l = G.rollEncounters(zone, 1, [k]).slice();
            if (l.length) n[k] = (n[k] || 0) + 1;
            return l;
          });
          lists.push(G.rollEncounters(zone, 1, G.ENC_IDS.slice()).slice());
          for (const list of lists) {
          placed += list.length;
          for (const e of list) {
            const p = e.site, why = [];
            for (const q of p.type === 'patrol' ? [p.a, p.b] : [p]) {
              if (Math.hypot(q.x - zone.start.x, q.z - zone.start.z) < E.startGap) why.push('起点');
              if (a.door && Math.hypot(q.x - a.door.x, q.z - a.door.z) < E.doorGap) why.push('场地门');
              if (W.roomAt(q.x, q.z) === a.room || W.inArena(q.x, q.z)) why.push('场地');
              if (W.hazardAt(q.x, q.z) & (W.HAZ.burn | W.HAZ.thin)) why.push('危险区');
              if (!W.walkable(q.x, q.z, 0.5)) why.push('墙里');
            }
            if (p.type === 'core' && !(W.sdAt(p.x, p.z) >= 7)) why.push('sd');
            if (p.type === 'side' && !p.door) why.push('门');
            if (e.kind === 'guard' && !(p.nodeD >= 14)) why.push('雷枢');
            for (const o of list) if (o !== e && Math.hypot(o.site.x - p.x, o.site.z - p.z) < E.gap) why.push('间距');
            if (why.length) bad.push(zone.def.id + '#' + s + ' ' + e.kind + '：' + why.join('、'));
          }
          }
        }
      }
      // 找不到点位：把旁支的候选清空，试锋放不下就换下一种（祈坛）；全部清空时一个都不放、不报错
      G.debug.zoneSeed(77);
      G.enterZone(2, 1);
      S.zone.encCand = { core: [], side: [], nook: S.zone.encCand && S.zone.encCand.nook ? S.zone.encCand.nook : null, patrol: [] };
      if (!S.zone.encCand.nook) delete S.zone.encCand.nook;
      const fb = G.rollEncounters(S.zone, 1, ['trial', 'shrine']).map((e) => e.kind).join(',');
      S.zone.encCand = { core: [], side: [], nook: [], patrol: [] };
      const none = G.rollEncounters(S.zone, 1, G.ENC_IDS.slice()).length;
      G.debug.zoneSeed(null);
      G.enterZone(0, 0);
      return { bad: bad.slice(0, 6), nBad: bad.length, placed, n, msMax: +msMax.toFixed(2), fb, none };
    });
    assert(!r.nBad, '有不合规的点位：' + JSON.stringify(r.bad));
    for (const k of ['guard', 'box', 'wanderer', 'shrine', 'trial', 'trader', 'echo', 'ember']) assert(r.n[k] >= 60, k + ' 在 100 个布局里单独放能放上的次数太少：' + JSON.stringify(r.n));
    assert(r.fb === 'shrine' && r.none === 0, '找不到点位时应换下一种 / 一个都不放：' + JSON.stringify(r));
    // 「选址单次不到 5 ms」是游戏用 performance.now 量的耗时，在 test:timed 里（计时｜异兆选址）
    return '放上 ' + r.placed + ' 个，各种 ' + JSON.stringify(r.n) + '，选址最慢 ' + r.msMax + ' ms';
  });

  await step('区域存档：站在雷枢峡谷 / 霜骨沼泽里存的档（布局生成器改过之后布局会不一样）读回来，从区域入口重新进区——玩家站在可走的地上、区域和层级 / 渊印接着用；存档里不记位置（塞进去的坐标被丢掉）', async () => {
    const r = await ev(() => {
      const keep = localStorage.getItem('cinder-abyss-save-v1'), out = {};
      const P = G.player, W = G.world, mt0 = G.save.maxTier;
      try {
        G.save.maxTier = Math.max(1, G.save.maxTier || 0); // 层级 1 要先解锁（读档时 tier 截到 maxTier）
        for (const id of ['storm', 'frost']) {
          const zi = G.ZONES.findIndex((z) => z.id === id);
          G.enterZone(zi, 1);
          const d = T.openDir(10);
          T.tp(P.x + d.x * 8, P.z + d.z * 8); // 走进区里再存
          G.persist();
          const raw = JSON.parse(localStorage.getItem('cinder-abyss-save-v1'));
          raw.player = { x: 9999, z: -9999 }; // 塞一个不认识的坐标：读档应丢掉
          raw.pos = [9999, -9999];
          localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
          const run0 = JSON.stringify(raw.run);
          G.loadSave();
          // 读档后进区和 main.js 的读档一样：接着存档里的那一次
          G.enterZone(G.save.lastZone, G.save.tier, 'resume');
          G.computeStats();
          const Z = G.state.zone;
          out[id] = {
            zone: Z.def.id, tier: G.state.tier, run: JSON.stringify(G.save.run) === run0,
            walk: W.walkable(P.x, P.z, 0.4), atStart: Math.hypot(P.x - Z.start.x, P.z - Z.start.z) < 2,
            junk: 'player' in G.save || 'pos' in G.save, boss: !!G.state.boss, enemies: G.state.enemies.length,
          };
        }
      } finally {
        if (keep) localStorage.setItem('cinder-abyss-save-v1', keep);
        G.loadSave();
        G.save.maxTier = mt0;
        G.computeStats();
        G.enterZone(0, 0);
      }
      return out;
    });
    for (const id of ['storm', 'frost']) {
      const o = r[id];
      assert(o && o.zone === id && o.tier === 1 && o.run, id + '：读档后区域 / 层级 / 渊印应接着用：' + JSON.stringify(o));
      assert(o.walk && o.atStart && !o.junk && o.boss && o.enemies > 20, id + '：读档后应从入口进区、站在可走的地上，存档里不该有坐标：' + JSON.stringify(o));
    }
    return '雷枢 / 霜骨：读档从入口进区、站在可走的地上';
  });

  await step('异兆懒生成：同一种子进区，开 / 关异兆时 state.enemies 的数量、类型、位置完全一样（进区时不刷异兆的怪，保护「经验」那一步）', async () => {
    const r = await ev(() => {
      const S = G.state, out = [];
      const orig = Math.random;
      const seeded = (seed) => {
        let a = seed >>> 0;
        return () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };
      const sig = () => S.enemies.map((e) => e.type + (e.elite ? '*' : '') + (e.isBoss ? '!' : '') + '@' + e.x.toFixed(3) + ',' + e.z.toFixed(3) + ':' + e.level + ':' + e.maxHp).join('|');
      try {
        for (let z = 0; z < 5; z++) {
          for (const t of [0, 2]) {
            G.debug.zoneSeed(4100 + z);
            Math.random = seeded(777 + z);
            G.debug.noEnc = true;
            G.enterZone(z, t);
            const a = sig(), na = S.enc.length;
            Math.random = seeded(777 + z);
            G.debug.noEnc = false;
            G.enterZone(z, t);
            const b = sig();
            out.push({ z: S.zone.def.id, t, same: a === b, n: S.enemies.length, off: na, on: S.enc.length, encMobs: S.enemies.filter((e) => e.enc).length });
          }
        }
      } finally {
        Math.random = orig;
        G.debug.noEnc = false;
        G.debug.zoneSeed(null);
        G.enterZone(0, 0);
      }
      return out;
    });
    for (const o of r) assert(o.same && o.off === 0 && o.encMobs === 0, '开 / 关异兆时进区的怪物列表不一样：' + JSON.stringify(o));
    assert(r.filter((o) => o.t === 2).every((o) => o.on >= 1), '层级 2 应该放了异兆（不然这一步什么也没比）：' + JSON.stringify(r));
    return r.map((o) => o.z + o.t + ':' + o.n + '只/' + o.on + '个').join(' ');
  });

  await step('异兆「守隙」：房间清空才张开；站进圈开始，4 波 4 / 5 / 6 / 6 只 + 精英（层级 2 两只），同场 ≤ 8；离圈 5 秒后计时倒退，退到 0 再 6 秒失败；倒下失败；坚守 30 秒成功并掉落', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, out = {};
      let enc = EK.put('guard', 3, 2);
      const s = enc.site;
      T.tp(s.x + 1, s.z);
      EK.step(0.2);
      out.sleep = enc.st;
      out.mobs0 = enc.mobs.length;
      EK.clearRoom(enc);
      EK.step(0.1);
      out.run = enc.st; // 玩家就在圈里：张开即开始
      let maxLive = 0;
      const waveN = [];
      EK.step(31, () => {
        maxLive = Math.max(maxLive, enc.mobs.filter((e) => !e.dead).length + enc.pend.length);
        if (waveN.length < enc.wave) waveN.push(enc.mobs.length + enc.pend.length + enc.queue.length);
        // 只留 3 只活着：让排队的接着刷，同时同场上限还要真的被顶到过一次
        const live = enc.mobs.filter((e) => !e.dead);
        if (enc.t > 18 && live.length > 3) EK.kill(live.slice(0, live.length - 3));
        return enc.st !== 'run';
      });
      out.st = enc.st;
      out.total = enc.mobs.length;
      out.elites = enc.mobs.filter((e) => e.elite).length;
      out.maxLive = maxLive;
      out.waveN = waveN;
      out.items = EK.items();
      // 离圈：5 秒内计时不动，之后每秒退 0.5；退到 0 之后再 6 秒失败
      enc = EK.put('guard', 3, 1);
      EK.clearRoom(enc);
      T.tp(enc.site.x, enc.site.z);
      EK.step(4);
      const t4 = enc.t;
      T.tp(enc.site.x + 8, enc.site.z);
      EK.step(4.5);
      out.hold = +(enc.t - t4).toFixed(2);
      EK.step(2);
      out.back = +(t4 - enc.t).toFixed(2); // 离圈 4.5 → 6.5 秒：倒退了 1.5 秒 × 0.5
      EK.step(7);
      out.zero = +enc.t.toFixed(2);
      out.stFail0 = enc.st;
      EK.step(6);
      out.stFail = enc.st;
      // 倒下：失败
      enc = EK.put('guard', 3, 1);
      EK.clearRoom(enc);
      T.tp(enc.site.x, enc.site.z);
      EK.step(2);
      P.dead = true;
      P.deadT = 1.6; // 同 G.hurtPlayer 打死时：倒地 1.6 秒后才重生
      EK.step(0.05);
      out.dead = enc.st;
      G.respawn();
      EK.done();
      return out;
    });
    assert(r.sleep === 'sleep' && r.mobs0 === 0 && r.run === 'run', '守隙应在房间清空后才张开、走进圈开始：' + JSON.stringify(r));
    assert(r.st === 'done' && r.total === 4 + 5 + 6 + 6 + 2 && r.elites === 2, '守隙的波次不对（层级 2：21 只轻怪 + 2 精英）：' + JSON.stringify(r));
    assert(r.maxLive <= 8 && r.maxLive >= 6, '守隙同场应 ≤ 8：' + JSON.stringify(r));
    assert(r.items >= 5, '守隙成功应掉落（精英表 2 次 + 1 件稀有）：' + JSON.stringify(r));
    assert(Math.abs(r.hold) < 0.05 && Math.abs(r.back - 0.75) < 0.1 && r.zero === 0 && r.stFail0 === 'run' && r.stFail === 'fail', '守隙离圈倒退 / 失败不对：' + JSON.stringify(r));
    assert(r.dead === 'fail', '守隙里倒下应失败：' + JSON.stringify(r));
    return '23 只（同场最多 ' + r.maxLive + '），离圈 6.5 秒倒退 ' + r.back + ' 秒';
  });

  await step('异兆「缚匣」：走到跟前崩开锁链，3 只匣卫（普通怪 ×2.2 生命、经验权重 1.5）；25 秒内全杀是解缚（掉落多），超时是残缚', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, out = {};
      let enc = EK.put('box', 1, 0);
      const s = enc.site;
      T.tp(s.x + 3, s.z);
      EK.step(0.2);
      out.idle = enc.st;
      T.tp(s.x + 0.8, s.z);
      EK.step(1.0);
      out.run = enc.st;
      out.n = enc.mobs.length;
      const g = enc.mobs[0];
      const ref = G.spawnMob(g.type, s.x + 30, s.z, g.level, {});
      out.hpK = +(g.maxHp / ref.maxHp).toFixed(2);
      out.xpK = +(G.killXp(g, 1) / G.killXp(ref, 1)).toFixed(2);
      G.clearEnemies();
      EK.kill(enc.mobs);
      EK.step(0.1);
      out.st = enc.st;
      out.how = enc.how;
      out.items = EK.items();
      // 超时
      enc = EK.put('box', 1, 0);
      T.tp(enc.site.x + 0.8, enc.site.z);
      EK.step(1.0);
      EK.step(25);
      out.late0 = enc.st;
      EK.kill(enc.mobs);
      EK.step(0.1);
      out.late = enc.how;
      out.lateItems = EK.items();
      EK.done();
      return out;
    });
    assert(r.idle === 'idle' && r.run === 'run' && r.n === 3, '缚匣应走到跟前才崩开、刷 3 只匣卫：' + JSON.stringify(r));
    assert(Math.abs(r.hpK - 2.2) < 0.02 && Math.abs(r.xpK - 0.75) < 0.02, '匣卫的生命 / 经验倍率不对（层级 0：权重 1.5 × 层级 0 的 0.5）：' + JSON.stringify(r));
    assert(r.st === 'done' && r.how === 'free' && r.items >= 4, '25 秒内全杀应是解缚（精英表掷 2 次）：' + JSON.stringify(r));
    assert(r.late0 === 'run' && r.late === 'late' && r.lateItems >= 2 && r.lateItems < r.items + 4, '超时应是残缚（只掷 1 次）：' + JSON.stringify(r));
    return '解缚 ' + r.items + ' 件，残缚 ' + r.lateItems + ' 件';
  });

  await step('异兆「游荡者」：在巡逻段两个房间之间来回走、拴在里面；钩链打中拽 4 m、遇墙停；图腾立着时减伤 40%；分身随本体一起散；燃烧地面最多 10 块；击杀掉落', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, W = G.world, out = {};
      // 名号逐个强制：每次重新放
      const make = (title) => {
        const enc = EK.put('wanderer', 3, 1);
        enc.title = title;
        T.tp(enc.site.a.x + 1, enc.site.a.z);
        EK.step(0.1);
        return enc;
      };
      // 巡逻 + 拴绳
      // 从 e 出发、一路 sd ≥ 1 的方向（钩链测试要一条直的空路）
      const clear = (e, len) => {
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
          let ok = true;
          for (let d = 1; d <= len && ok; d += 0.5) if (!(W.sdAt(e.x + dx * d, e.z + dz * d) >= 1)) ok = false;
          if (ok) return { x: dx, z: dz };
        }
        return { x: 1, z: 0 };
      };
      let enc = make('chain'), e = enc.mob;
      T.tp(e.x + 18, e.z + 18); // 50 m 外的怪整帧跳过：离远一点但别太远，也别叫醒它
      const x0 = e.x, z0 = e.z;
      EK.step(3);
      out.patrol = +Math.hypot(e.x - x0, e.z - z0).toFixed(2);
      out.name = e.name;
      let leash = true;
      for (let i = 0; i < 80; i++) {
        G.pullEnemy(e, e.x + 3, e.z + 1.5, 0.6);
        if (!G.leashRoomOk(e, e.x, e.z)) leash = false;
      }
      for (let i = 0; i < 80; i++) {
        G.pullEnemy(e, e.x - 2, e.z - 3, 0.6);
        if (!G.leashRoomOk(e, e.x, e.z)) leash = false;
      }
      out.leash = leash;
      // 钩链：直接拽 4 m；前面插一道假墙时停在墙前
      const u = clear(e, 9);
      T.tp(e.x + u.x * 8, e.z + u.z * 8);
      const m1 = G.encHookPlayer(e.x, e.z, 4, 0.6);
      out.hook = +m1.toFixed(2);
      T.tp(e.x + u.x * 8, e.z + u.z * 8);
      const wx = P.x - u.x * 1.2, wz = P.z - u.z * 1.2, wk = W.walkable;
      W.walkable = (x, z, pad) => ((x - wx) * u.x + (z - wz) * u.z < (pad || 0) ? false : wk(x, z, pad)); // 离玩家 1.2 m 处一道垂直于钩链的假墙
      const m2 = G.encHookPlayer(e.x, e.z, 4, 0.6);
      W.walkable = wk;
      out.wallHook = +m2.toFixed(2);
      // 钩链的预警：醒着、6 m 内，按节奏甩出长条预警，打中就拽
      T.tp(e.x + u.x * 6, e.z + u.z * 6);
      e.awake = true;
      e.encT = 0;
      e.atkCd = 9;
      let tele = null;
      EK.step(0.05, () => (tele = S.telegraphs.find((t) => t.owner === e && t.shape === 'rect')));
      out.tele = tele ? tele.len + '×' + tele.w + '@' + tele.dur : null;
      const dA = Math.hypot(P.x - e.x, P.z - e.z);
      EK.step(0.9);
      out.pulled = +(dA - Math.hypot(P.x - e.x, P.z - e.z)).toFixed(2);
      // 灰誓者：75% 立两根图腾，立着时减伤 40%、回血；打碎后恢复
      enc = make('oath');
      e = enc.mob;
      e.awake = true;
      T.tp(e.x + 3, e.z);
      e.hp = e.maxHp * 0.7;
      EK.step(0.1);
      out.totems = (e.encTotems || []).filter((t) => !t.dead).length;
      out.dr = e.encDR;
      const h0 = e.hp;
      EK.step(1);
      out.regen = +((e.hp - h0) / e.maxHp).toFixed(3);
      EK.kill(e.encTotems);
      EK.step(0.1);
      out.dr2 = e.encDR;
      // 镜影客：60% 分一个分身；本体死了分身一起散，分身不给经验
      enc = make('mirror');
      e = enc.mob;
      e.awake = true;
      T.tp(e.x + 3, e.z);
      e.hp = e.maxHp * 0.55;
      EK.step(0.1);
      const cl = e.encClones || [];
      out.clones = cl.length;
      out.cloneHp = cl[0] ? +(cl[0].maxHp / e.maxHp).toFixed(2) : 0;
      out.cloneXp = cl[0] ? G.killXp(cl[0], 1) : -1;
      G.killEnemy(e);
      EK.step(0.1);
      out.cloneGone = cl.every((c) => c.dead);
      out.mirrorSt = enc.st;
      out.items = EK.items();
      // 拖烬者：边走边留燃烧地面，最多 10 块；50% 一圈 8 个圆形预警
      enc = make('cinder');
      e = enc.mob;
      e.awake = true;
      e.atkCd = 99;
      T.tp(e.x + 18, e.z + 18);
      // 走动时每 0.5 秒一块、4 秒消失（常态最多 8 块）；把间隔临时缩到 0.1 秒验上限 10
      const CT = G.WANDERER.titles.cinder, ev0 = CT.every;
      EK.step(3, () => {
        e.moving = true;
        e.awake = true;
      });
      out.cinders0 = G.encCinders.length;
      CT.every = 0.1;
      EK.step(3, () => {
        e.moving = true;
        e.awake = true;
      });
      CT.every = ev0;
      out.cinders = G.encCinders.length;
      e.hp = e.maxHp * 0.45;
      const nT = S.telegraphs.length;
      EK.step(0.05);
      out.ring = S.telegraphs.filter((t) => t.owner === e && t.shape === 'circle').length;
      out.ringN0 = nT;
      EK.done();
      return out;
    });
    assert(r.patrol > 1.5 && r.leash, '游荡者应在巡逻段里走动、拽不出拴绳：' + JSON.stringify(r));
    assert(/^拖链者·../.test(r.name), '游荡者的名字应是「称号·名」：' + r.name);
    assert(Math.abs(r.hook - 4) < 0.01 && r.wallHook < 1.0, '钩链应拽 4 m、遇墙停：' + JSON.stringify(r));
    assert(r.tele === '11×1.4@0.85' && r.pulled > 3, '钩链的预警 / 打中拽人不对：' + JSON.stringify(r));
    assert(r.totems === 2 && r.dr === 0.4 && Math.abs(r.regen - 0.01) < 0.002 && r.dr2 === 0, '灰誓者的图腾 / 减伤 / 回血不对：' + JSON.stringify(r));
    assert(r.clones === 1 && r.cloneHp === 0.3 && r.cloneXp === 0 && r.cloneGone && r.mirrorSt === 'done' && r.items >= 3, '镜影客的分身 / 击杀结算不对：' + JSON.stringify(r));
    assert(r.cinders0 === 6 && r.cinders === 10 && r.ring === 8, '拖烬者的燃烧地面上限 / 烬环不对：' + JSON.stringify(r));
    return r.name + '，钩链 ' + r.hook + ' m（遇墙 ' + r.wallHook + ' m）';
  });

  await step('异兆「祈坛」：按 F 激活随机一种；四种增益（疾风移速 / 出手、坚壁减伤不被拽、丰饶掉落 ×1.5、渊涌冷却 / 消耗）各自生效，到期恢复', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, out = {};
      const enc = EK.put('shrine', 1, 0);
      T.tp(enc.site.x + 1.5, enc.site.z);
      EK.step(0.1);
      out.F = G.pickupNearest();
      out.used = enc.used && enc.st === 'done' && !!P.encBuff;
      out.again = G.encUse(enc);
      P.encBuff = null;
      G.computeStats();
      const ms0 = P.moveSpeed, mv0 = P.S.moveSpeed, sp0 = P.S.speed;
      const id = G.save.bar.find((k) => k && G.SKILLS[k].cd > 0 && G.SKILLS[k].mana > 0) || G.save.bar.find((k) => k && G.SKILLS[k].mana > 0);
      const c0 = G.skillCtx(id);
      G.encBuff('gale');
      out.gale = [P.S.moveSpeed - mv0, P.S.speed - sp0, P.moveSpeed > ms0]; // 「提高」类：和装备 / 天赋的同类属性相加
      G.encBuff('ward');
      out.ward = [P.S.lessTaken, G.encNoKb()];
      G.encBuff('surge');
      const c1 = G.skillCtx(id);
      out.surge = [c0.cd > 0 ? +(c1.cd / c0.cd).toFixed(2) : 0.6, +(c1.cost / Math.max(1, c0.cost)).toFixed(2), c0.cost];
      // 丰饶：普通怪的物品 / 通货掉落 ×1.5，宝石不变
      const count = (n) => {
        const c = {}, sp = G.spawnLoot;
        G.spawnLoot = (k) => ((c[k] = (c[k] || 0) + 1), null);
        try {
          for (let i = 0; i < n; i++) G.encDropLoot({ level: 30, x: 0, z: 0, def: G.MOBS.husk, horde: true, hordeK: 1 });
        } finally {
          G.spawnLoot = sp;
        }
        return c;
      };
      P.encBuff = null;
      const a = count(100000);
      G.encBuff('bounty');
      const b = count(100000);
      out.bounty = [+(b.item / a.item).toFixed(2), +(b.cur / a.cur).toFixed(2), a.skill + a.support + a.blank, b.skill + b.support + b.blank];
      // 到期
      G.encBuff('gale', 0.5);
      EK.step(0.6);
      out.expired = !P.encBuff && Math.abs(P.moveSpeed - ms0) < 1e-6;
      EK.done();
      return out;
    });
    assert(r.F && r.used && !r.again, '祈坛应按 F 激活、只能用一次：' + JSON.stringify(r));
    assert(r.gale[0] === 25 && r.gale[1] === 15 && r.gale[2], '疾风不对（移速 +25%、攻击 / 施法速度 +15%）：' + JSON.stringify(r));
    assert(r.ward[0] === 25 && r.ward[1] === true, '坚壁不对：' + JSON.stringify(r));
    assert(Math.abs(r.surge[0] - 0.6) < 0.02 && (r.surge[2] < 4 || Math.abs(r.surge[1] - 0.5) < 0.15), '渊涌不对：' + JSON.stringify(r));
    assert(Math.abs(r.bounty[0] - 1.5) < 0.12 && Math.abs(r.bounty[1] - 1.5) < 0.12 && Math.abs(r.bounty[3] / r.bounty[2] - 1) < 0.15, '丰饶不对（物品 / 通货 ×1.5，宝石不变）：' + JSON.stringify(r));
    assert(r.expired, '增益到期没有恢复：' + JSON.stringify(r));
    return '丰饶 物品 ×' + r.bounty[0] + ' 通货 ×' + r.bounty[1];
  });

  await step('异兆「试锋」：跨过门口的符文开始（站在门洞里不算），3 波 5 / 6 / 6（第 3 波 2 只精英），小室里的怪拴在房间里；打完按剩余时间评级；离开小室超过 4 秒弃权，没清掉的怪散掉', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, W = G.world, out = {};
      let enc = EK.put('trial', 2, 1);
      const s = enc.site;
      // 站在门外（门点本身可能已经算进小室）：沿「房间芯 → 门」再往外 1.5–4 m，找一个可走、不在小室里的点
      const ux = s.door.x - s.x, uz = s.door.z - s.z, ul = Math.hypot(ux, uz) || 1;
      let out0 = null;
      for (let d = 1.5; d <= 4 && !out0; d += 0.5) {
        const x = s.door.x + (ux / ul) * d, z = s.door.z + (uz / ul) * d;
        if (W.walkable(x, z, 0.4) && W.roomAt(x, z) !== s.room) out0 = { x, z };
      }
      out.outside = !!out0;
      T.tp(out0 ? out0.x : s.door.x, out0 ? out0.z : s.door.z);
      EK.step(0.1);
      out.idle = enc.st;
      // 站在门洞里（门点上，可能已经算进小室）：还没跨过符文，不开始
      T.tp(s.door.x, s.door.z);
      EK.step(0.1);
      out.doorway = enc.st;
      T.tp(s.x, s.z);
      EK.step(1.0);
      out.run = enc.st;
      out.w1 = enc.mobs.length;
      // 拴绳：把一只往门外拽，拽不出去
      const m = enc.mobs[0];
      const ox = s.door.x + (s.door.x - s.x) * 3, oz = s.door.z + (s.door.z - s.z) * 3;
      for (let i = 0; i < 120; i++) G.pullEnemy(m, ox, oz, 0.5);
      out.leash = G.leashRoomOk(m, m.x, m.z) && (W.roomAt(m.x, m.z) === s.room || Math.hypot(m.x - s.door.x, m.z - s.door.z) <= 3.01);
      const waves = [enc.mobs.length];
      for (let w = 0; w < 3; w++) {
        EK.kill(enc.mobs);
        EK.step(1.0);
        waves.push(enc.mobs.length);
      }
      out.waves = waves;
      out.elites = enc.mobs.filter((e) => e.elite).length;
      out.st = enc.st;
      out.how = enc.how;
      out.items = EK.items();
      // 弃权
      enc = EK.put('trial', 2, 1);
      T.tp(enc.site.x, enc.site.z);
      EK.step(1.0);
      T.tp(enc.site.door.x + (enc.site.door.x - enc.site.x) * 2, enc.site.door.z + (enc.site.door.z - enc.site.z) * 2);
      EK.step(3.5);
      out.quit0 = enc.st;
      EK.step(1.0);
      out.quit = enc.how;
      out.gone = enc.mobs.every((e) => e.dead);
      EK.done();
      return out;
    });
    assert(r.outside && r.idle === 'idle' && r.doorway === 'idle' && r.run === 'run' && r.w1 === 5, '试锋应跨过门口的符文才开始（门洞里不算）、第一波 5 只：' + JSON.stringify(r));
    assert(r.leash, '试锋的怪应拴在小室里：' + JSON.stringify(r));
    assert(r.waves.join(',') === '5,11,17,17' && r.elites === 2 && r.st === 'done' && r.how === 'top' && r.items >= 3, '试锋的波次 / 评级不对：' + JSON.stringify(r));
    assert(r.quit0 === 'run' && r.quit === 'quit' && r.gone, '离开小室超过 4 秒应弃权、怪散掉：' + JSON.stringify(r));
    return '波次 ' + r.waves.join(' → ') + '，评级 ' + r.how;
  });

  await step('异兆「拾烬客」：按 F 打开货架（至少 1 件稀有），买得起才能买、扣对价钱；卖东西按分解价 +1 微光尘；烛芯任意 2 换 1（层级 2 起）', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, sv = G.save, out = {};
      const cur0 = JSON.stringify(sv.cur), bag0 = sv.bag.slice(), fr0 = JSON.stringify(sv.frags);
      try {
        let enc = EK.put('trader', 3, 2);
        T.tp(enc.site.x + 1.5, enc.site.z);
        EK.step(0.1);
        out.F = G.pickupNearest();
        out.open = G.ui.isOpen();
        out.html = !!document.querySelector('#panel-body .trader .trd-row');
        const st = enc.stock;
        out.rare = st.filter((o) => o.kind === 'item' && o.item.rarity >= 2).length;
        out.gem = st.some((o) => o.kind === 'skill' || o.kind === 'support');
        for (const k in sv.cur) sv.cur[k] = 0;
        out.poor = G.traderBuy(0);
        sv.cur.regal = 3;
        sv.cur.exalt = 2;
        sv.bag.length = 0;
        out.buy = G.traderBuy(0);
        out.left = [sv.cur.regal, sv.cur.exalt];
        out.inBag = sv.bag.length === 1 && sv.bag[0] === st[0].item;
        out.twice = G.traderBuy(0);
        // 卖：按分解价，魔法以上 +1 微光尘
        const it = sv.bag[0], exp = G.salvageResult(it);
        const d0 = sv.cur.dust || 0;
        const got = G.traderSell(it);
        out.sell = (got.dust || 0) === (exp.dust || 0) + 1 && sv.bag.length === 0 && (sv.cur.dust || 0) === d0 + (exp.dust || 0) + 1;
        // 烛芯 2 换 1
        sv.frags = { seal: 3, rift: 0, vow: 1, box: 0 };
        out.swap = JSON.stringify(G.traderSwap('rift'));
        out.frags = JSON.stringify(sv.frags);
        sv.frags = { seal: 1, rift: 0, vow: 0, box: 0 };
        out.short = G.traderSwap('box');
        G.ui.close();
        enc = EK.put('trader', 3, 1);
        T.tp(enc.site.x + 1.5, enc.site.z);
        EK.step(0.1);
        G.encUse(enc);
        sv.frags = { seal: 4, rift: 0, vow: 0, box: 0 };
        out.t1 = G.traderSwap('rift');
        G.ui.close();
      } finally {
        sv.cur = JSON.parse(cur0);
        sv.bag = bag0;
        sv.frags = JSON.parse(fr0);
        EK.done();
      }
      return out;
    });
    assert(r.F && r.open && r.html && r.rare >= 1 && r.gem, '拾烬客的货架不对：' + JSON.stringify(r));
    assert(r.poor === 'cost' && r.buy === true && r.left.join() === '1,1' && r.inBag && r.twice === 'none', '买东西不对：' + JSON.stringify(r));
    assert(r.sell, '卖东西应按分解价 +1 微光尘：' + JSON.stringify(r));
    assert(r.swap === '{"seal":2}' && r.frags === '{"seal":1,"rift":1,"vow":1,"box":0}' && r.short === false && r.t1 === false, '烛芯 2 换 1 不对：' + JSON.stringify(r));
    return '货架 ' + r.rare + ' 件稀有，2 换 1：' + r.frags;
  });

  await step('异兆「拾烬客」看得清：体型放大、头顶画着「拾烬客」名牌、提着一盏灯（加色的发光贴片 + 脚下一圈暖光，场景里不多一盏灯）；换区后一起清掉', async () => {
    await encKit();
    const r = await ev(() => {
      const W = G.world, out = {};
      const lights = () => {
        let n = 0;
        W.scene.traverse((o) => { if (o.isLight) n++; });
        return n;
      };
      try {
        const enc = EK.put('trader', 0, 2);
        const l0 = lights();
        T.tp(enc.site.x + 5, enc.site.z + 1);
        EK.step(0.3);
        W.update(0, 5);
        W.render();
        const H = enc.prop;
        out.k = H && H.npc ? +H.npc.body.scale.x.toFixed(2) : 0;
        out.tag = H && H.tagAt;
        const foot = W.project(enc.site.x, 0, enc.site.z);
        out.tagOk = !!out.tag && out.tag[1] > 0 && out.tag[1] < foot.y - 40 && Math.abs(out.tag[0] - foot.x) < 40;
        out.lamp = !!(H && H.lamp && H.lamp.visible && H.lamp.material.blending === THREE.AdditiveBlending && H.lamp.parent === H.npc.body);
        out.pool = !!(H && H.pool && H.pool.visible && H.pool.material.blending === THREE.AdditiveBlending && !H.pool.castShadow);
        out.lights = lights() - l0;
        G.enterZone(0, 0);
        out.gone = H.npc.removed === true && !(H.pool.parent && H.pool.parent.parent);
      } finally {
        EK.done();
      }
      return out;
    });
    assert(r.k >= 1.25 && r.tagOk && r.lamp && r.pool && r.lights === 0 && r.gone, '拾烬客的体型 / 名牌 / 灯不对：' + JSON.stringify(r));
    return '体型 ×' + r.k + '，名牌在 ' + r.tag.join(',');
  });

  await step('异兆「残影」的浮现点：玩家站在房间芯南边（芯在画面顶上、残影的头出画）时，浮现点挪到房间里画面看得见的地方（离玩家 5–9 m、脚下和头顶都在画面里），预警环和残影都在那里；芯本来就在画面里时不挪', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, W = G.world, out = {};
      try {
        for (let k = 0; k < 6 && !out.found; k++) {
          const enc = EK.put('echo', 3, 1, 1700 + k * 11);
          if (!enc) continue;
          const s = enc.site;
          let spot = null;
          for (const d of [7.5, 7, 6.5, 6]) for (const dx of [0, 1.5, -1.5]) {
            const x = s.x + dx, z = s.z + d;
            if (!spot && W.roomAt(x, z) === s.room && W.walkable(x, z, 0.6)) spot = { x, z };
          }
          if (!spot) continue;
          T.tp(spot.x, spot.z, Math.PI);
          EK.step(0.1);
          if (W.inView(s.x, s.z, 4.6)) continue; // 芯在画面里（这个布局测不了挪动）
          out.found = true;
          EK.clearRoom(enc);
          EK.step(0.1, () => enc.st === 'run');
          const at = enc.at;
          out.moved = !!at && (at.x !== s.x || at.z !== s.z);
          out.room = W.roomAt(at.x, at.z) === s.room;
          out.d = +Math.hypot(at.x - P.x, at.z - P.z).toFixed(1);
          out.seen = W.inView(at.x, at.z, 0.2) && W.inView(at.x, at.z, 4.6);
          EK.step(1.2, () => !!enc.mob);
          out.mobAt = !!enc.mob && Math.hypot(enc.mob.x - at.x, enc.mob.z - at.z) < 0.5;
        }
        // 芯本来就在画面里：不挪
        const enc = EK.put('echo', 3, 1);
        T.tp(enc.site.x + 6, enc.site.z);
        EK.step(0.1);
        EK.clearRoom(enc);
        EK.step(0.1, () => enc.st === 'run');
        out.stay = !!enc.at && enc.at.x === enc.site.x && enc.at.z === enc.site.z;
      } finally {
        EK.done();
      }
      return out;
    });
    assert(r.found && r.moved && r.room && r.d >= 5 && r.d <= 9 && r.seen && r.mobAt && r.stay, '残影的浮现点不对：' + JSON.stringify(r));
    return '挪到离玩家 ' + r.d + ' m';
  });

  await step('异兆「残影」：房间清空后浮现本区首领的残影（首领生命 35%、等级 +2、只用前两种招式、不狂暴、拴在房间里）；不改 G.state.boss，打死不开传送门、不记首杀', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, sv = G.save, out = {};
      const enc = EK.put('echo', 3, 1);
      const boss = S.boss, kills0 = JSON.stringify(sv.bossKills), cleared0 = JSON.stringify(sv.cleared);
      T.tp(enc.site.x + 6, enc.site.z);
      EK.step(0.2);
      out.sleep = enc.st;
      EK.clearRoom(enc);
      EK.step(1.0);
      const e = enc.mob;
      out.spawned = !!e && e.echo && e.isBoss;
      out.bossSame = S.boss === boss && !boss.echo;
      const def = G.BOSSES[S.zone.def.boss];
      out.hpK = +(e.maxHp / Math.round(def.hp * G.hpScale(e.level))).toFixed(3);
      out.lv = e.level - enc.level;
      out.pats = e.def.patterns.join(',') === def.patterns.slice(0, 2).join(',');
      out.leash = e.leashRooms && e.leashRooms[0] === enc.site.room;
      EK.step(1.0);
      out.awake = e.awake;
      e.hp = e.maxHp * 0.3;
      EK.step(0.3);
      out.rage = e.enraged;
      G.killEnemy(e);
      EK.step(0.1);
      out.st = enc.st;
      out.portal = !!S.portal;
      out.kills = JSON.stringify(sv.bossKills) === kills0 && JSON.stringify(sv.cleared) === cleared0;
      out.items = EK.items();
      EK.done();
      return out;
    });
    assert(r.sleep === 'sleep' && r.spawned && r.bossSame, '残影应在房间清空后浮现、不改 G.state.boss：' + JSON.stringify(r));
    assert(Math.abs(r.hpK - 0.35) < 0.01 && r.lv === 2 && r.pats && r.leash && r.awake && !r.rage, '残影的数值 / 招式 / 拴绳 / 狂暴不对：' + JSON.stringify(r));
    assert(r.st === 'done' && !r.portal && r.kills && r.items >= 2, '残影的击杀结算不对：' + JSON.stringify(r));
    return '残影生命 ×' + r.hpK + '，掉落 ' + r.items + ' 件';
  });

  await step('异兆「落烬」：房间清空后摸烬核开始；余烬预警同时 ≤ 3 个，打怪 ×3；4 块烬晶全打碎判成功并掉落；超时失败', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, out = {};
      let enc = EK.put('ember', 3, 1);
      const unquiet = EK.quiet(); // 整步只有余烬在打怪：不然召唤物 / 光环 / 按住的右键会在量伤害的窗口里补刀，烬晶也可能被它们打碎
      const s = enc.site;
      T.tp(s.x + 3, s.z);
      EK.step(0.2);
      out.sleep = enc.st;
      EK.clearRoom(enc);
      EK.step(0.1);
      out.open = enc.st;
      T.tp(s.x + 0.8, s.z); // 摸一下烬核
      EK.step(1.0);
      out.run = enc.st;
      out.shards = enc.shards.length;
      let maxT = 0;
      for (let i = 0; i < 40; i++) {
        EK.step(0.25);
        maxT = Math.max(maxT, S.telegraphs.filter((t) => enc.tele.indexOf(t) >= 0).length);
      }
      out.maxTele = maxT;
      // 余烬打怪：靶子站在玩家脚下，下一团瞄着玩家落（随机数临时压低），挨的是整数倍的 3 × 小怪一击。
      // 窗口里只许余烬扣血：附近别的怪先清掉（掉落一起清，不混进后面的件数），靶子不攒异常、不吃架势
      for (const e of S.enemies) if (!e.dead && !e.fixed && !e.isBoss && Math.hypot(e.x - P.x, e.z - P.z) < 16) G.killEnemy(e);
      T.clearLoot();
      const dummy = G.spawnMob('husk', P.x, P.z, enc.level, { awake: false });
      dummy.hp = dummy.maxHp = 1e7;
      dummy.atkCd = 1e9;
      dummy.speed = 0;
      dummy.buTh = 1e15;
      dummy.poiseMax = 0;
      const hit = G.ENCOUNTERS.ember.p.hitK * G.MOBS.husk.dmg * G.dmgScale(enc.level) * G.ENCOUNTERS.ember.p.mobK;
      enc.tele.length = 0;
      enc.fallT = 0;
      // 逐帧记靶子掉的血：每一下都得正好是整数团余烬（同一帧落两团就是 2 倍），别的来源哪怕一点点也算错
      let hp0 = dummy.hp;
      const drops = [];
      const watch = () => {
        if (dummy.hp !== hp0) drops.push(+((hp0 - dummy.hp) / hit).toFixed(6));
        hp0 = dummy.hp;
      };
      const rnd = Math.random;
      Math.random = () => 0.1;
      EK.step(1 / 60, watch);
      Math.random = rnd;
      EK.step(1.2, watch);
      out.drops = drops;
      out.mobHit = +((1e7 - dummy.hp) / hit).toFixed(2);
      G.killEnemy(dummy);
      EK.kill(enc.shards);
      EK.step(0.1);
      out.st = enc.st;
      out.items = EK.items();
      // 超时
      enc = EK.put('ember', 3, 1);
      EK.clearRoom(enc);
      T.tp(enc.site.x + 0.8, enc.site.z);
      EK.step(26);
      out.late = enc.st;
      out.gone = enc.shards.every((e) => e.dead);
      EK.done();
      unquiet();
      return out;
    });
    assert(r.sleep === 'sleep' && r.open === 'open' && r.run === 'run' && r.shards === 4, '落烬应清空房间后摸烬核开始、立 4 块烬晶：' + JSON.stringify(r));
    assert(r.maxTele >= 1 && r.maxTele <= 3, '余烬预警同时应 ≤ 3：' + JSON.stringify(r));
    assert(r.drops.length >= 1 && r.drops.every((d) => d >= 1 && Math.abs(d - Math.round(d)) < 1e-6), '余烬打怪应是 3 倍小怪一击，每一下都是整数团、没有别的伤害：' + JSON.stringify(r));
    assert(r.st === 'done' && r.items >= 4 && r.late === 'fail' && r.gone, '落烬的成功 / 超时不对：' + JSON.stringify(r));
    return '预警最多 ' + r.maxTele + ' 个，打怪 ' + r.mobHit + ' 倍一击';
  });

  await step('异兆小地图：进区就画灰色六边形，走到 24 m 内换成这一种的图样（祈坛：青色十字），用过之后变暗', async () => {
    await encKit();
    const r = await ev(() => {
      const S = G.state, P = G.player, W = G.world, out = {};
      const enc = EK.put('shrine', 1, 0);
      const s = enc.site;
      // 小地图上 (x, z) 周围 radius 像素里有没有满足条件的像素
      const scan = (x, z, rad, ok) => {
        const m = W.minimapXY(x, z);
        let n = 0;
        for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) if (ok(W.minimapPixel(Math.round(m.x) + dx, Math.round(m.y) + dy))) n++;
        return n;
      };
      const grey = (q) => Math.abs(q[0] - q[1]) < 14 && Math.abs(q[1] - q[2]) < 14 && q[0] > 150;
      const cyan = (q) => q[1] > 170 && q[2] > 170 && q[0] < 150;
      // 远处（> 24 m、不同房间）：六边形
      let far = null;
      for (const c of S.zone.rooms) if (c.core && Math.hypot(c.core.x - s.x, c.core.z - s.z) > 34 && Math.hypot(c.core.x - s.x, c.core.z - s.z) < 60 && W.walkable(c.core.x, c.core.z, 0.5)) far = c.core;
      if (!far) far = { x: S.zone.start.x, z: S.zone.start.z };
      T.tp(far.x, far.z);
      EK.step(0.05);
      W.update(0);
      W.render();
      out.seen0 = enc.seen;
      out.grey0 = scan(s.x, s.z, 5, grey);
      out.cyan0 = scan(s.x, s.z, 5, cyan);
      // 走到 20 m 内（玩家的圆点不盖住标记）
      // 找一个离点位 14–20 m、可走的地方站（玩家的圆点不盖住标记）
      let near = null;
      for (let rr = 16; rr <= 20 && !near; rr += 2) for (let k = 0; k < 24 && !near; k++) {
        const a = (k / 24) * Math.PI * 2, x = s.x + Math.sin(a) * rr, z = s.z + Math.cos(a) * rr;
        if (W.walkable(x, z, 0.5)) near = { x, z };
      }
      for (let rr = 14; !near && rr >= 8; rr -= 2) for (let k = 0; k < 24 && !near; k++) {
        const a = (k / 24) * Math.PI * 2, x = s.x + Math.sin(a) * rr, z = s.z + Math.cos(a) * rr;
        if (W.walkable(x, z, 0.5)) near = { x, z };
      }
      T.tp(near.x, near.z);
      EK.step(0.05);
      W.update(0);
      W.render();
      out.seen1 = enc.seen;
      out.cyan1 = scan(s.x, s.z, 5, cyan);
      const m = W.minimapXY(s.x, s.z);
      out.c1 = W.minimapPixel(Math.round(m.x), Math.round(m.y));
      enc.used = true;
      enc.st = 'done';
      W.render();
      out.c2 = W.minimapPixel(Math.round(m.x), Math.round(m.y));
      EK.done();
      return out;
    });
    assert(!r.seen0 && r.grey0 >= 6 && r.cyan0 === 0, '远处应是灰色六边形：' + JSON.stringify(r));
    assert(r.seen1 && r.cyan1 >= 10 && r.c1[1] > 170 && r.c1[2] > 170 && r.c1[0] < 150, '走近后应换成青色十字：' + JSON.stringify(r));
    assert(r.c2[1] < r.c1[1] - 30, '用过之后图样应变暗：' + JSON.stringify(r));
    return '六边形 ' + r.grey0 + ' 像素 → 十字 ' + r.cyan1 + ' 像素';
  });

  await step('异兆出现规则 + 烛芯：层级 0 只有 40% 出 1 个、池里没有守隙 / 试锋 / 残影；层级 ≥ 1 一个、40% 两个；烛芯只在层级 ≥ 2 掉、几率按择的印（素印 = 浅印 40%、深印 70%、烬印 100%，没有保底），六个来源都一样；印烛芯非烈印的首领也掉；存档读回、旧存档为 0、旧的 fragPity 丢掉不再存', async () => {
    const r = await ev(() => {
      const S = G.state, sv = G.save, out = {};
      G.debug.zoneSeed(5150);
      G.enterZone(3, 0);
      const zone = S.zone;
      const n0 = {}, kinds0 = {};
      for (let i = 0; i < 3000; i++) {
        const l = G.rollEncounters(zone, 0);
        n0[l.length] = (n0[l.length] || 0) + 1;
        for (const e of l) kinds0[e.kind] = 1;
      }
      const n1 = {};
      for (let i = 0; i < 3000; i++) {
        const l = G.rollEncounters(zone, 1);
        n1[l.length] = (n1[l.length] || 0) + 1;
      }
      out.p0 = +((n0[1] || 0) / 3000).toFixed(3);
      out.max0 = Math.max(...Object.keys(n0).map(Number));
      out.kinds0 = Object.keys(kinds0).sort().join(',');
      out.p2 = +((n1[2] || 0) / 3000).toFixed(3);
      out.min1 = Math.min(...Object.keys(n1).map(Number));
      G.debug.zoneSeed(null);
      // 烛芯：按这次进区择的印掷一次（S.run.seal 的档位 g；null 是素印）
      const orig = Math.random, fr0 = JSON.stringify(sv.frags), run0 = S.run, rm0 = G.runMods;
      const drops = [];
      const sp = G.spawnLoot;
      G.spawnLoot = (k, d) => (drops.push(k + ':' + d), { x: 0, z: 0 });
      const seal = (g) => (g == null ? null : { g, mods: [{ id: 'swift' }], W: 4 });
      // 六个来源各掷一次：守隙 / 游荡者 / 缚匣 / 试锋 / 落烬 / 区域首领，掉了记 1
      const at = (g, r) => {
        S.run = { seal: seal(g), mods: rm0 };
        Math.random = () => r;
        return [G.encFragDrop('guard', 0, 0), G.encFragDrop('wanderer', 0, 0), G.encFragDrop('box', 0, 0), G.encFragDrop('trial', 0, 0), G.encFragDrop('ember', 0, 0), G.fragSealDrop({ x: 0, z: 0 })].map((b) => (b ? 1 : 0)).join('');
      };
      try {
        S.tier = 1;
        out.t1 = at(2, 0) + at(null, 0);
        out.t1Drops = drops.length;
        S.tier = 2;
        out.plain = at(null, 0.399) + '/' + at(null, 0.4);
        out.g0 = at(0, 0.399) + '/' + at(0, 0.4);
        out.g1 = at(1, 0.699) + '/' + at(1, 0.7);
        out.g2 = at(2, 0.9999);
        out.g2Drops = drops.slice(-6).join(',');
        out.chance = [null, 0, 1, 2].map((g) => G.fragChance(seal(g), 2)).join(',') + '|' + G.fragChance(seal(2), 1);
        // 首领掉落的钩子：非烈印（W 4）的烬印下击杀区域首领也掉印烛芯；层级 1 不掉
        Math.random = orig;
        S.run = { seal: seal(2), mods: rm0 };
        out.lie = !!G.runMods.lie;
        drops.length = 0;
        G.dropLoot({ isBoss: true, bossKind: null, level: 50, x: 0, z: 0 });
        out.boss = drops.filter((d) => d === 'frag:seal').length;
        S.tier = 1;
        drops.length = 0;
        G.dropLoot({ isBoss: true, bossKind: null, level: 50, x: 0, z: 0 });
        out.boss1 = drops.filter((d) => d.indexOf('frag:') === 0).length;
      } finally {
        Math.random = orig;
        G.spawnLoot = sp;
        S.tier = 0;
        S.run = run0;
        G.runMods = rm0;
      }
      // 存档：烛芯读回；坏数据夹回范围；旧存档没有 frags → 0；旧存档的保底计数 fragPity 读档丢掉，存档里也不再写
      out.fresh = 'fragPity' in G.newSave();
      sv.frags = { seal: 2, rift: 120, vow: -3, box: 1.7 };
      sv.fragPity = { seal: 3, rift: 99, vow: 2, box: 'x' };
      G.persist();
      const s2 = G.loadSave();
      out.load = JSON.stringify(s2.frags) + ('fragPity' in s2);
      G.persist();
      const k = Object.keys(localStorage).find((q) => /cinder-abyss-save/.test(q));
      out.resaved = /fragPity/.test(localStorage.getItem(k));
      const raw = JSON.parse(JSON.stringify(sv));
      delete raw.frags;
      raw.fragPity = { seal: 1 };
      localStorage.setItem(k, JSON.stringify(raw));
      const s3 = G.loadSave();
      out.old = JSON.stringify(s3.frags) + ('fragPity' in s3);
      sv.frags = JSON.parse(fr0);
      G.persist();
      G.enterZone(0, 0);
      return out;
    });
    assert(Math.abs(r.p0 - 0.4) < 0.04 && r.max0 === 1 && r.kinds0 === 'box,ember,shrine,trader,wanderer', '层级 0 的出现规则不对：' + JSON.stringify(r));
    assert(Math.abs(r.p2 - 0.4) < 0.04 && r.min1 === 1, '层级 ≥ 1 的出现规则不对：' + JSON.stringify(r));
    assert(r.t1 === '000000000000' && r.t1Drops === 0, '层级 1 不该掉烛芯（烬印、几率掷 0 也不掉）：' + JSON.stringify(r));
    assert(r.chance === '0.4,0.4,0.7,1|0', '烛芯几率（素印 / 浅印 / 深印 / 烬印 | 层级 1）不对：' + JSON.stringify(r));
    assert(r.plain === '111111/000000' && r.g0 === '111111/000000' && r.g1 === '111111/000000' && r.g2 === '111111', '烛芯按档位的几率不对（0.399 / 0.4、0.699 / 0.7、烬印 0.9999）：' + JSON.stringify(r));
    assert(r.g2Drops === 'frag:rift,frag:vow,frag:box,frag:box,frag:box,frag:seal', '六个来源掉的烛芯种类不对：' + JSON.stringify(r));
    assert(!r.lie && r.boss === 1 && r.boss1 === 0, '非烈印的区域首领应掉印烛芯、层级 1 不掉：' + JSON.stringify(r));
    assert(!r.fresh && r.load === '{"seal":2,"rift":99,"vow":0,"box":1}false' && !r.resaved && r.old === '{"seal":0,"rift":0,"vow":0,"box":0}false', '烛芯的存档不对（fragPity 应丢掉）：' + JSON.stringify(r));
    return '层级 0 出现 ' + r.p0 + '，层级 1 两个 ' + r.p2 + '，烛芯 ' + r.chance;
  });

  // ================================================================== 熄烛者（D5：巅峰首领，余烛殿）
  // 放在「localStorage 不可用」之前。每一步最后 G.enterZone(0, 0) 回到普通区域（T.arena 会调 G.respawn，在余烛殿里会熄魂灯，不在那里用）
  await step('余烛殿·地图：最高层级 < 2 没有节点、≥ 2 才有；烛芯不齐时「点燃」禁用、G.lightPinnacle 拒绝；齐了点燃扣掉四种各 1 个进场；等级 = 17 + 20 × 层级 + 5；state.zoneIdx 不变，存档挂上 run.pin', async () => {
    const r = await ev(() => {
      const sv = G.save, S = G.state, out = {};
      T.arena();
      const keep = { maxTier: sv.maxTier, frags: JSON.stringify(sv.frags) };
      sv.maxTier = 1;
      G.ui.open('map');
      out.node1 = !!document.querySelector('.pin-node');
      G.ui.close();
      sv.maxTier = 3;
      for (const id of G.FRAG_IDS) sv.frags[id] = 1;
      sv.frags.vow = 0;
      G.ui.open('map');
      out.node3 = !!document.querySelector('.pin-node');
      const btn = document.querySelector('[data-act="pin-light"]');
      out.disabled = !!(btn && btn.disabled);
      out.tiers = Array.from(document.querySelectorAll('[data-act="pin-tier"]')).map((n) => n.dataset.tier).join();
      G.ui.close();
      out.refuse = !G.lightPinnacle(2).ok && S.zone.def.id !== 'crown' && sv.frags.seal === 1;
      sv.frags.vow = 2;
      out.refuse1 = !G.lightPinnacle(1).ok && S.zone.def.id !== 'crown';
      const zi = S.zoneIdx;
      G.ui.open('map');
      document.querySelector('[data-act="pin-tier"][data-tier="3"]').click();
      document.querySelector('[data-act="pin-light"]').click();
      out.closed = T.tab() === null;
      out.zone = S.zone.def.id;
      out.level = [S.zone.level, S.boss.level, G.pinLevel(2)].join();
      out.zi = S.zoneIdx === zi && !G.ZONES.some((z) => z.id === 'crown');
      out.frags = JSON.stringify(sv.frags);
      out.run = JSON.stringify(sv.run.pin);
      G.ui.update(); // HUD 每帧才刷新一次
      out.hud = document.getElementById('pin-lamps').classList.contains('on') && document.querySelectorAll('#pin-lamps .lamp.on').length;
      G.enterZone(0, 0);
      G.ui.update();
      out.back = !S.pin && !document.getElementById('pin-lamps').classList.contains('on') && !G.save.run.pin;
      sv.maxTier = keep.maxTier;
      sv.frags = JSON.parse(keep.frags);
      return out;
    });
    assert(!r.node1 && r.node3 && r.disabled && r.tiers === '2,3' && r.refuse && r.refuse1, '节点 / 禁用 / 拒绝不对：' + JSON.stringify(r));
    assert(r.closed && r.zone === 'crown' && r.level === '82,82,62' && r.zi, '进场 / 等级不对：' + JSON.stringify(r));
    assert(r.frags === '{"seal":0,"rift":0,"vow":1,"box":0}' && r.run === '{"tier":3,"lives":3}' && r.hud === 3 && r.back, '扣烛芯 / 存档 / 魂灯 HUD 不对：' + JSON.stringify(r));
    return '层级 3 首领等级 ' + r.level.split(',')[0] + ' · 烛芯 ' + r.frags;
  });

  await step('余烛殿·场地：固定布局通过校验（0 条失败）、两次生成哈希相同；起点 r 8、通道、场地 bossR = 15；4 个火盆台是 WALL（挡人挡子弹）、在圆心外 10.5 m；外面是 VOID（挡人不挡子弹）；首领生命 3300 × hpScale、架势 900、伤害 15 × dmgScale', async () => {
    const r = await ev(() => {
      const W = G.world, S = G.state, out = {};
      const g = W.genLayout('crown', 0), g2 = W.genLayout('crown', 12345);
      out.ok = g.ok;
      out.why = g.why.join(';');
      out.same = g.hash === g2.hash;
      G.save.maxTier = Math.max(G.save.maxTier, 2);
      G.enterPinnacle(2);
      const z = S.zone, info = W.layoutInfo();
      out.kinds = info.rooms.map((q) => q.kind).join();
      out.start = JSON.stringify(info.rooms[0].core);
      out.bossR = z.bossR;
      const br = W.crownInfo().br;
      out.br = br.map((b) => (W.walkable(b.x, b.z, 0) ? 1 : 0) + '' + (W.matAt(b.x, b.z) === W.MAT.WALL ? 1 : 0) + (W.shotFree(b.x, b.z) ? 1 : 0)).join();
      out.brR = br.map((b) => Math.round(Math.hypot(b.x - z.bossPos.x, b.z - z.bossPos.z) * 10) / 10).join();
      out.void = (W.walkable(0, -54, 0) ? 1 : 0) + '' + (W.matAt(0, -54) === W.MAT.VOID ? 1 : 0) + (W.shotFree(0, -54) ? 1 : 0);
      out.door = W.walkable(z.bossDoor.x, z.bossDoor.z, 0.5) && Math.hypot(z.bossDoor.x - z.bossPos.x, z.bossDoor.z - z.bossPos.z) > G.PIN.burnOut;
      const B = S.boss;
      out.hp = Math.round(B.maxHp) === Math.round(3300 * G.hpScale(62));
      out.poise = B.poiseMax;
      out.dmg = Math.abs(B.dmg - 15 * G.dmgScale(62)) < 1e-6;
      out.noPacks = S.enemies.length === 1 && !(S.enc && S.enc.length) && !z.chests.length && !G.state.run.seal;
      G.enterZone(0, 0);
      return out;
    });
    assert(r.ok && r.same, '余烛殿的布局没通过校验：' + r.why);
    assert(r.kinds === 'start,link,arena' && r.start === '{"x":0,"z":0,"r":8}' && r.bossR === 15 && r.door, '房间 / 起点 / bossR / 门不对：' + JSON.stringify(r));
    assert(r.br === '010,010,010,010' && r.brR === '10.5,10.5,10.5,10.5' && r.void === '011', '火盆台 / 虚空不对：' + JSON.stringify(r));
    assert(r.hp && r.poise === 900 && r.dmg && r.noPacks, '首领数值 / 场地里多了东西：' + JSON.stringify(r));
    return '布局 0 条失败 · 火盆 ' + r.brR;
  });

  await step('余烛殿·阶段：71% 不切、70% 以下进熄灯（掐灭 2 个、雾 16 / 34、暖光 10）；暗潮在亮着的火盆 4 m 内不掉血、外面挨 0.6 倍一击；熄灭的火盆旁站 1.5 s 重燃（3.5 m 外不算）；掐灯至少留 1 个亮着；35% 以下进冠焰（全部点燃、亮度复原、外圈预警后起火：外圈掉血、圈内不掉）', async () => {
    const r = await ev(() => {
      const W = G.world, S = G.state, P = G.player, out = {};
      const step = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) G.tick(1 / 60); };
      G.save.maxTier = Math.max(G.save.maxTier, 2);
      G.enterPinnacle(2);
      const B = S.boss, Q = S.pin, A = G.PIN.arena;
      T.tp(A.x, A.z + 8);
      P.god = true;
      step(0.3);
      out.awake = B.awake;
      B.hp = B.maxHp * 0.71;
      B.busy = 0;
      step(0.5);
      out.p71 = B.phase + '' + Q.phase;
      B.hp = B.maxHp * 0.69;
      B.busy = 0;
      step(0.4);
      out.p69 = B.phase + '' + Q.phase;
      out.lit2 = Q.lit.reduce((a, b) => a + b, 0);
      const gi = W.gloomInfo();
      out.gloom = [gi.near, gi.far, gi.lamp].join();
      // 暗潮：首领定住，计时器推远
      B.busy = 1e9;
      Q.tideT = Q.snuffT = 1e9;
      const li = Q.lit.indexOf(1), ui = Q.lit.indexOf(0), lb = Q.br[li], ub = Q.br[ui];
      const away = (b, d) => { const dx = b.x - A.x, dz = b.z - A.z, l = Math.hypot(dx, dz); return { x: b.x - (dx / l) * d, z: b.z - (dz / l) * d }; };
      const safe = away(lb, 2.6), bad = away(ub, 6);
      P.god = false;
      P.iframe = 0;
      P.life = P.maxLife;
      T.tp(safe.x, safe.z);
      G.pinTideHit(B);
      out.tideSafe = P.life === P.maxLife && G.pinSafeAt(P.x, P.z);
      T.tp(bad.x, bad.z);
      G.pinTideHit(B);
      out.tideHit = P.maxLife - P.life;
      out.tideRaw = B.dmg * G.PIN.tide.k;
      P.life = P.maxLife;
      // 完整的一次暗潮（招式）：站在安全圈里，预警 1.6 s 内画出暗潮 / 安全圈，结算不掉血
      T.tp(safe.x, safe.z);
      B.busy = 0;
      G.snufferPattern(B, 'tide');
      step(0.8);
      out.tideMid = +Q.tideK.toFixed(2) + ' ' + W.crownInfo().fx + ' ' + W.crownInfo().safeA;
      step(1.0);
      out.tideAfter = Q.tideK + ' ' + (P.life === P.maxLife);
      B.busy = 1e9;
      // 重燃
      const near = away(ub, -2.3), far = away(ub, -3.6);
      T.tp(far.x, far.z);
      step(1.6);
      out.relightFar = Q.lit[ui];
      T.tp(near.x, near.z);
      step(1.0);
      out.relight10 = Q.lit[ui];
      step(0.6);
      out.relight16 = Q.lit[ui];
      // 至少留 1 个
      const lit0 = Q.lit.slice();
      Q.lit = [1, 0, 0, 0];
      out.keepOne = G.pinSnuff(0) === false && Q.lit[0] === 1;
      Q.lit = lit0;
      out.snuffOk = G.pinSnuff(Q.lit.indexOf(1)) === true;
      // 冠焰
      P.god = true;
      T.tp(A.x, A.z + 8);
      B.hp = B.maxHp * 0.34;
      B.busy = 0;
      step(0.2);
      out.p34 = B.phase + '' + Q.phase;
      B.busy = 1e9;
      step(1.0);
      out.allLit = Q.lit.join('') + ' ' + W.gloomInfo().near;
      out.warn = S.telegraphs.some((t) => t.shape === 'ring' && t.rin === G.PIN.burnIn) && !Q.burn;
      step(1.6);
      out.burn = Q.burn && W.crownInfo().burn;
      P.god = false;
      P.iframe = 0;
      P.life = P.maxLife;
      T.tp(A.x, A.z + 8);
      step(1.2);
      out.inner = P.life === P.maxLife;
      T.tp(A.x, A.z + 14.5);
      step(1.2);
      out.outer = P.maxLife - P.life;
      out.burnRaw = G.TERRAIN.burn * G.dmgScale(Q.level);
      P.god = true;
      G.enterZone(0, 0);
      P.god = false;
      return out;
    });
    assert(r.awake && r.p71 === '00' && r.p69 === '11' && r.lit2 === 2 && r.gloom === '16,34,10', '进熄灯不对：' + JSON.stringify(r));
    assert(r.tideSafe && r.tideHit > 0 && r.tideHit <= r.tideRaw && r.tideMid.split(' ').slice(1).join(' ') === 'true 1' && r.tideAfter === '0 true', '暗潮不对：' + JSON.stringify(r));
    assert(r.relightFar === 0 && r.relight10 === 0 && r.relight16 === 1 && r.keepOne && r.snuffOk, '重燃 / 掐灯不对：' + JSON.stringify(r));
    assert(r.p34 === '22' && /^1111 22$/.test(r.allLit) && r.warn && r.burn && r.inner && r.outer > 0 && r.outer <= r.burnRaw * 2.05, '冠焰不对：' + JSON.stringify(r));
    return '暗潮外面扣 ' + Math.round(r.tideHit) + ' · 外圈 1.2 s 扣 ' + Math.round(r.outer);
  });

  await step('余烛殿·魂灯：倒下熄一盏、在门外重生，首领保留生命和阶段、火盆回到这一阶段开始时；第 3 次倒下失败：退还 2 个不同的烛芯、回到原来那一区并打开地图；读档：魂灯数保留、首领满血；坏数据丢掉、旧存档没有 pinnacle', async () => {
    const r = await ev(() => {
      const S = G.state, P = G.player, sv = G.save, out = {};
      const step = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) G.tick(1 / 60); };
      const die = () => { P.god = false; P.iframe = 0; P.life = 1; G.hurtPlayer(1e9, 'phys', null); step(1.8); };
      G.enterZone(2, 0);
      const keep = JSON.stringify(sv.frags);
      sv.maxTier = Math.max(sv.maxTier, 2);
      G.enterPinnacle(2);
      const B = S.boss, Q = S.pin, A = G.PIN.arena;
      T.tp(A.x, A.z + 8);
      P.god = true;
      step(0.3);
      B.hp = B.maxHp * 0.6;
      B.busy = 0;
      step(0.4);
      B.busy = 1e9;
      const start = Q.start.join('');
      Q.lit = [0, 0, 0, 1];
      die();
      out.d1 = [Q.lives, sv.run.pin.lives, (B.hp / B.maxHp).toFixed(2), B.phase, Q.lit.join('') === start, Math.round(P.x) + ',' + Math.round(P.z)].join(' ');
      out.door = Math.round(S.zone.bossDoor.x) + ',' + Math.round(S.zone.bossDoor.z);
      G.ui.update();
      out.hud = document.querySelectorAll('#pin-lamps .lamp.on').length + '/' + document.querySelectorAll('#pin-lamps .lamp').length;
      // 读档：魂灯数保留，重进首领满血
      G.persist();
      G.loadSave();
      out.saved = JSON.stringify(sv.run.pin);
      G.enterPinnacle(sv.run.pin.tier, 'resume');
      out.resume = S.pin.lives + ' ' + (S.boss.hp === S.boss.maxHp);
      // 第 2、3 次
      const f0 = {};
      for (const id of G.FRAG_IDS) f0[id] = sv.frags[id];
      die();
      out.d2 = S.pin && S.pin.lives;
      die();
      out.fail = !S.pin && S.zone.def.id === G.ZONES[2].id && T.tab() === 'map' && !(sv.run && sv.run.pin);
      const gain = G.FRAG_IDS.map((id) => sv.frags[id] - f0[id]);
      out.refund = gain.join('') + ' ' + JSON.stringify(S.pinRefund);
      out.refundOk = gain.reduce((a, b) => a + b, 0) === G.PIN_REFUND && gain.every((g) => g === 0 || g === 1) && S.pinRefund.length === 2;
      G.ui.close();
      // 坏数据：魂灯 9、层级 1 → 丢掉；旧存档没有 pinnacle
      const raw = JSON.parse(localStorage.getItem('cinder-abyss-save-v1'));
      raw.run = { zone: raw.lastZone, tier: raw.tier, seq: 1, seal: null, pin: { tier: 2, lives: 9 } };
      raw.pinnacle = { kills: -4, pity: 99 };
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      out.bad = JSON.stringify(sv.run && sv.run.pin) + ' ' + JSON.stringify(sv.pinnacle);
      raw.run.pin = { tier: 1, lives: 2 };
      delete raw.pinnacle;
      localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(raw));
      G.loadSave();
      out.old = JSON.stringify(sv.run && sv.run.pin) + ' ' + JSON.stringify(sv.pinnacle);
      sv.frags = JSON.parse(keep);
      G.persist();
      G.enterZone(0, 0);
      return out;
    });
    const d1 = r.d1.split(' ');
    assert(d1[0] === '2' && d1[1] === '2' && d1[2] === '0.60' && d1[3] === '1' && d1[4] === 'true' && d1[5] === r.door && r.hud === '2/3', '第一次倒下不对：' + JSON.stringify(r));
    assert(r.saved === '{"tier":2,"lives":2}' && r.resume === '2 true' && r.d2 === 1, '读档 / 第二次倒下不对：' + JSON.stringify(r));
    assert(r.fail && r.refundOk, '第 3 次倒下应失败、退还 2 个不同的烛芯：' + JSON.stringify(r));
    assert(r.bad === 'undefined {"kills":0,"pity":3}' && r.old === 'undefined {"kills":0,"pity":0}', '坏数据 / 旧存档不对：' + JSON.stringify(r));
    return '倒下 ' + r.d1 + ' · 退还 ' + r.refund;
  });

  await step('余烛殿·掉落：首杀必掉一件巅峰渊契（熄烛冠 / 双生坠，没拾到过的优先）、记首杀和 2 点天赋；不记区域通关、不开下一层；之后 30%，连续 3 次没掉第 4 次必掉；另 20% 掉一件普通渊契；打完开传送门、读档不再回余烛殿', async () => {
    const r = await ev(() => {
      const S = G.state, sv = G.save, out = {};
      const keep = { kills: JSON.stringify(sv.bossKills), cleared: JSON.stringify(sv.cleared), maxTier: sv.maxTier, pin: JSON.stringify(sv.pinnacle), found: JSON.stringify(sv.relic.found) };
      sv.maxTier = Math.max(sv.maxTier, 2);
      const mt = sv.maxTier;
      delete sv.bossKills.snuffer;
      sv.pinnacle = { kills: 0, pity: 0 };
      sv.relic.found.xizhu = true;
      delete sv.relic.found.shuangsheng;
      const pts0 = G.passivePoints().total, lv0 = sv.level;
      const kill = (fix) => {
        G.enterPinnacle(2);
        T.clearLoot();
        if (fix !== undefined) T.fix(fix);
        G.killEnemy(S.boss, {});
        T.unfix();
        return S.loot.filter((l) => l.kind === 'item' && l.data.rarity === 4).map((l) => l.data.rq);
      };
      const k1 = kill(0.999);
      out.first = k1.join() + ' ' + JSON.stringify(S.pinLast);
      out.pts = G.passivePoints().total - pts0 - (sv.level - lv0); // 击杀的经验可能升级：只看首杀给的那 2 点
      out.noClear = JSON.stringify(sv.cleared) === keep.cleared && sv.maxTier === mt;
      out.portal = !!S.portal && !(sv.run && sv.run.pin);
      out.loot = S.loot.filter((l) => l.kind === 'item' && l.data.rarity === 2).length + '/' + S.loot.filter((l) => l.kind === 'cur').length + '/' + S.loot.filter((l) => l.kind === 'blank').length + '/' + S.loot.filter((l) => l.kind === 'support').length;
      const seq = [];
      for (let i = 0; i < 4; i++) seq.push(kill(0.999).length);
      out.pity = seq.join('') + ' ' + JSON.stringify(sv.pinnacle);
      const k6 = kill(0.25);
      out.chance = k6.length;
      const k7 = kill(0.1);
      out.normal = k7.filter((id) => G.RELIC_IDS.indexOf(id) >= 0).length + '+' + k7.filter((id) => G.RELIC_PINNACLE.indexOf(id) >= 0).length;
      G.enterZone(0, 0);
      sv.bossKills = JSON.parse(keep.kills);
      sv.pinnacle = JSON.parse(keep.pin);
      sv.relic.found = JSON.parse(keep.found);
      sv.maxTier = keep.maxTier;
      return out;
    });
    assert(/^shuangsheng /.test(r.first) && /"first":true/.test(r.first) && r.pts === 2 && r.noClear && r.portal, '首杀不对：' + JSON.stringify(r));
    assert(r.loot === '3/6/1/2', '必掉的件数不对（3 稀有、6 通货、1 无铭、2 辅助）：' + r.loot);
    assert(r.pity === '0001 {"kills":5,"pity":0}' && r.chance === 1 && r.normal === '1+1', '保底 / 几率不对：' + JSON.stringify(r));
    return '首杀 ' + r.first.split(' ')[0] + ' · 保底 ' + r.pity.split(' ')[0];
  });

  await step('渊契「双生」：选了刻式的技能每次施放在 A / B 之间交替（你选的那一种先），交替出来的那一种伤害 +10%，放出去的投射物带着自己那份定义；光环、召唤不交替；魔力不够没放出去不算一次；摘下后指回选的那一种', async () => {
    const r = await ev(() => {
      const S = G.state, P = G.player, out = {};
      RQT.begin('shuangsheng');
      RQT.learn('ember', 0);
      G.save.variants.ember = 'a';
      G.applyVariants();
      T.dummy(0, 7);
      T.aim(P.x, P.z + 7);
      const seq = [], projV = [];
      const sp0 = G.spawnProjectile;
      let lastV = '-';
      G.spawnProjectile = function (p) { if (p.owner === 'p' && p.ctx) lastV = p.ctx.sk.variant; return sp0.call(this, p); };
      for (let i = 0; i < 4; i++) {
        P.cds = {};
        P.mana = P.maxMana;
        G.input.tap[0] = 1;
        let t = 0;
        while (!P.cast && t++ < 30) G.debug.step(1 / 60);
        seq.push(G.SKILLS.ember.variant);
        lastV = '-';
        t = 0;
        while (P.cast && t++ < 120) G.debug.step(1 / 60);
        projV.push(lastV);
      }
      G.spawnProjectile = sp0;
      out.seq = seq.join('');
      out.proj = projV.join('');
      const ka = G.skillCtx('ember').more;
      G.useVariant('ember', 'a');
      const kA = G.skillCtx('ember').more;
      G.useVariant('ember', 'b');
      const kB = G.skillCtx('ember').more;
      out.alt = +(kB / kA).toFixed(3);
      // 没放出去不算一次
      G.useVariant('ember', 'a');
      G.relicState.twin.ember = 'b';
      P.mana = 0;
      P.cds = {};
      G.input.tap[0] = 1;
      G.debug.step(0.1);
      out.noMana = G.relicState.twin.ember;
      P.mana = P.maxMana;
      // 光环 / 召唤
      RQT.learn('nova', 2);
      G.save.variants.nova = 'b';
      RQT.learn('thrall', 3);
      G.save.variants.thrall = 'a';
      G.applyVariants();
      G.relicState.twin = {};
      out.skip = [G.relicTwin('nova'), G.relicTwin('thrall'), G.relicTwin('ember')].join();
      // 摘下
      G.save.equip.amulet = null;
      G.computeStats();
      out.off = G.SKILLS.ember === G.skillVariant('ember', 'a') && G.relicState.twinAlt.size === 0 && Math.abs(G.skillCtx('ember').more - kA) < 1e-9;
      delete G.save.variants.ember;
      delete G.save.variants.nova;
      delete G.save.variants.thrall;
      G.applyVariants();
      RQT.end();
      return out;
    });
    assert(r.seq === 'abab' && r.proj === 'abab', '交替顺序不对：' + JSON.stringify(r));
    assert(r.alt === 1.1 && r.noMana === 'b', '交替那一下的伤害 / 没放出去不算：' + JSON.stringify(r));
    assert(r.skip === ',,a' && r.off, '光环 / 召唤 / 摘下不对：' + JSON.stringify(r));
    return '施放 ' + r.seq + ' · 交替那一下 ×' + r.alt;
  });

  await step('渊契「暗域」（熄烛冠）：暖光半径 −40%（摘下复原）；9 m 外睡着的怪不会因为距离醒（不戴时 12 m 内就醒）；已醒的怪在 9 m 外 3 s 失去目标、走回原地（9 m 内不会）；首领不会失去目标', async () => {
    const r = await ev(() => {
      const S = G.state, P = G.player, W = G.world, out = {};
      RQT.begin('xizhu');
      P.graceT = 0; // T.arena 里的重生给了 2.5 秒不被就近发现
      out.lamp = W.gloomInfo().lamp;
      const dir = T.openDir(16);
      const at = (d) => ({ x: P.x + dir.x * d, z: P.z + dir.z * d });
      const sleeper = (d) => { const q = at(d); const e = G.spawnMob('husk', q.x, q.z, 1, {}); e.hp = e.maxHp = 1e6; e.atkCd = 1e9; return e; };
      const e1 = sleeper(10.5);
      G.debug.step(1.0);
      out.noWake = !e1.awake;
      G.save.equip.helm = null;
      G.computeStats();
      out.lampOff = W.gloomInfo().lamp;
      G.debug.step(0.5);
      out.wakeOff = e1.awake;
      G.clearEnemies();
      G.save.equip.helm = G.rollRelic('xizhu', 50, 0.5);
      G.computeStats();
      // 已醒：12 m 外（不动）3 s 后失去目标，8 m 内的不会
      const fa = T.mob('husk', dir.x * 12, dir.z * 12), na = T.mob('husk', dir.x * 7, dir.z * 7);
      fa.speed = na.speed = 0;
      // 走回原地：这一只离出生点 3 m（出生点也在 9 m 外），失去目标后自己走回去
      const fb = T.mob('husk', dir.x * 13, dir.z * 13);
      fb.speed = 0;
      fb.home = { x: fb.x + dir.z * 3, z: fb.z - dir.x * 3 };
      G.debug.step(2.9);
      out.still = fa.awake;
      G.debug.step(0.5);
      out.lost = !fa.awake && na.awake && !fb.awake && fb.homing;
      fb.speed = G.MOBS.husk.speed;
      G.debug.step(2.5);
      out.home = +Math.hypot(fb.x - fb.home.x, fb.z - fb.home.z).toFixed(2) + ' ' + fb.awake;
      // 首领不吃仇恨这部分
      const b = G.spawnBoss('golem', P.x + dir.x * 14, P.z + dir.z * 14, 1);
      b.awake = b.wasAwake = true;
      b.cd = b.busy = 1e9;
      b.speed = 0;
      G.debug.step(3.4);
      out.boss = b.awake;
      G.clearEnemies();
      RQT.end();
      out.lampEnd = W.gloomInfo().lamp;
      return out;
    });
    assert(Math.abs(r.lamp - 9.6) < 1e-6 && r.lampOff === 16 && r.lampEnd === 16, '暖光不对：' + JSON.stringify(r));
    assert(r.noWake && r.wakeOff && r.still && r.lost && /^0\.\d+ false$/.test(r.home) && parseFloat(r.home) < 0.8, '醒来 / 失去目标 / 走回原地不对：' + JSON.stringify(r));
    assert(r.boss, '首领不对：' + JSON.stringify(r));
    return '暖光 ' + r.lamp;
  });

  await step('渊契「暗域」（熄烛冠）：身周 8 m / 召唤物身周 2.5 m 内的敌人在域内；暗域增伤（词缀，中值 24%）对你的伤害近处远处都 ×1.24、召唤物只对域内 ×1.24；没发现你时第一击必暴；域内的怪打你 / 打召唤物 ×0.8（首领 ×0.9、熄烛者 ×1）；熄烛者单次仍封顶 85%；暗域圈 1 次 draw（玩家 + 召唤物）；摘下当场复原', async () => {
    const r = await ev(() => {
      const S = G.state, P = G.player, W = G.world, out = {};
      RQT.begin('xizhu');
      P.graceT = 0;
      out.v = P.S.darkDmg;
      const dir = T.openDir(16);
      G.save.bar[0] = 'blade';
      RQT.learn('blade', 0);
      const ctx = G.skillCtx('blade');
      // 近 5 m（域内）、12 m（域外）、10 m 处一只给召唤物贴着
      const near = T.mob('husk', dir.x * 5, dir.z * 5), far = T.mob('husk', dir.x * 12, dir.z * 12), mid = T.mob('husk', dir.x * 10 + dir.z * 3, dir.z * 10 - dir.x * 3);
      G.debug.step(0.05);
      out.flags1 = [near.dark, far.dark, mid.dark].join();
      RQT.learn('thrall', 2); // 没学的召唤技能，召唤物会被解散
      const th = G.summonMinion('thrall', P.x, P.z, G.skillCtx('thrall'));
      th.x = mid.x - dir.x * 1.6; th.z = mid.z - dir.z * 1.6;
      th.speed = 0;
      G.debug.step(0.05);
      th.x = mid.x - dir.x * 1.6; th.z = mid.z - dir.z * 1.6;
      G.debug.step(0.02);
      out.flags2 = [near.dark, far.dark, mid.dark].join();
      out.ring = W.darkInfo();
      // 伤害：随机数钉在 0.5（不暴击）
      T.fix(0.5);
      const base = G.calcHit(ctx, 1).total;
      const k = (h) => +(h.total / base).toFixed(3);
      out.you = [k(G.relicDarkHit(near, ctx, 1, false)), k(G.relicDarkHit(far, ctx, 1, false))].join();
      out.mine = [k(G.relicDarkHit(mid, ctx, 1, true)), k(G.relicDarkHit(far, ctx, 1, true))].join();
      // hitEnemy 走的是同一条路：域外的靶子挨一下飞刃 = 基础 × 1.24
      const hp0 = far.hp;
      G.hitEnemy(far, ctx, 1, {});
      out.hitFar = +((hp0 - far.hp) / base).toFixed(3);
      far.awake = false;
      out.sneak = G.relicDarkHit(far, ctx, 1, false).crit + ' ' + G.relicDarkHit(mid, ctx, 1, true).crit;
      far.awake = true;
      T.unfix();
      // 受到的伤害（火焰：只吃抗性，线性）
      P.god = false;
      const hurt = (src) => { P.iframe = 0; P.life = P.maxLife; G.hurtPlayer(100, 'fire', src); return P.maxLife - P.life; };
      const dNear = hurt(near), dFar = hurt(far), dProj = hurt({ x: near.x, z: near.z, owner: near });
      out.weak = [+(dNear / dFar).toFixed(3), +(dProj / dFar).toFixed(3)].join();
      const golem = G.spawnBoss('golem', P.x + dir.x * 6, P.z + dir.z * 6, 1);
      golem.cd = golem.busy = 1e9; golem.speed = 0;
      G.debug.step(0.02);
      out.weakBoss = [golem.dark, G.darkWeakK(golem), G.darkWeakK({ dark: true, isBoss: true, pin: true })].join();
      // 熄烛者：不吃削弱，单次照样封顶 85%
      P.iframe = 0; P.life = P.maxLife;
      G.hurtPlayer(1e9, 'fire', { x: near.x, z: near.z, dark: true, isBoss: true, pin: true });
      out.cap = +(1 - P.life / P.maxLife).toFixed(3);
      P.life = P.maxLife;
      // 召唤物挨打
      const mh = (src) => { th.hp = th.maxHp; G.hurtMinion(th, 100, 'fire', src); return th.maxHp - th.hp; };
      out.minionWeak = +(mh(mid) / mh(far)).toFixed(3);
      // 摘下：当场复原（面板秒伤也跟着回去）
      const cB = G.skillCtx('blade'), dps1 = G.skillDps(cB), v0 = P.S.darkDmg;
      P.S.darkDmg = 0;
      out.dps = +(dps1 / G.skillDps(cB)).toFixed(2);
      P.S.darkDmg = v0;
      G.save.equip.helm = null;
      G.computeStats();
      G.debug.step(0.02);
      out.off = [near.dark, mid.dark, P.relic.xizhu === undefined, W.darkInfo().r].join();
      out.offHit = +(G.calcHit(ctx, 1).total > 0) + ' ' + +(hurt(near) / dFar).toFixed(3);
      G.debug.step(1.0);
      out.offRing = W.darkInfo().visible;
      P.god = true;
      G.clearEnemies();
      RQT.end();
      return out;
    });
    assert(r.v === 24, '暗域增伤词缀（中值）不对：' + JSON.stringify(r));
    assert(r.flags1 === 'true,false,false' && r.flags2 === 'true,false,true', '域内判定不对：' + JSON.stringify(r));
    assert(r.ring.visible && r.ring.r === 8 && r.ring.mr === 2.5 && r.ring.n === 2, '暗域圈不对：' + JSON.stringify(r));
    assert(r.you === '1.24,1.24' && r.mine === '1.24,1' && r.hitFar === 1.24 && r.sneak === 'true false', '增伤 / 必暴不对：' + JSON.stringify(r));
    assert(r.weak === '0.8,0.8' && r.weakBoss === 'true,0.9,1' && r.minionWeak === 0.8 && r.cap === 0.85, '削弱 / 85% 上限不对：' + JSON.stringify(r));
    assert(r.off === 'false,false,true,0' && r.offHit === '1 1' && r.offRing === false && r.dps === 1.24, '摘下没复原 / 面板秒伤没算暗域增伤：' + JSON.stringify(r));
    return '增伤 ×' + r.you.split(',')[0] + ' · 域内伤害 ×' + r.weak.split(',')[0] + ' · 首领 ×0.9 · 上限 ' + r.cap;
  });

  await step('熄烛冠改版的存档迁移：旧熄烛冠（生命 / 暴击 / 冰霜抗性）读档后原地升级，各行分位不变（冰霜抗性 → 生命回复），新增暗域增伤按 uid 固定；只迁一次、提示一次（看过不再出）；新掉的直接是新版', async () => {
    const r = await ev(() => {
      const out = {};
      const OLD = [['life', [1.2, 1.6]], ['crit', [1.2, 1.6]], ['resCold', [1.0, 1.3]]], tier = 8, il = 50;
      const oldItem = (q, uid) => {
        const it = G.rollRelic('xizhu', il, 0.5);
        delete it.rqv;
        it.uid = uid;
        it.affixes = OLD.map(([id, k]) => { const t = G.affixRange(G.AFFIX_BY_ID[id], tier); const lo = Math.max(1, Math.round(t[0] * k[0])), hi = Math.max(lo, Math.round(t[1] * k[1])); return { id, tier, v: Math.round(lo + (hi - lo) * q) }; });
        return it;
      };
      const a = oldItem(0.25, 'xzA'), b = oldItem(1, 'xzB');
      const keep = { bag: G.save.bag.slice(), helm: G.save.equip.helm, tut: Object.assign({}, G.save.tut), xzMig: G.save.xzMig };
      delete G.save.tut.xzmig;
      G.save.bag.length = 0;
      G.save.bag.push(JSON.parse(JSON.stringify(b)));
      G.save.equip.helm = JSON.parse(JSON.stringify(a));
      G.persist();
      G.loadSave();
      const A = G.save.equip.helm, B = G.save.bag.find((x) => x.rq === 'xizhu');
      const q = (it, i) => { const rg = G.relicLineRange('xizhu', il, i); return +((it.affixes[i].v - rg[0]) / (rg[1] - rg[0])).toFixed(2); };
      out.ids = A.affixes.map((x) => x.id).join();
      // 分位：两次取整（旧值、新值）各差不到半格，按 ±0.02 比
      out.qA = [0, 1, 2].map((i) => q(A, i)).join();
      out.qB = [0, 1, 2].map((i) => q(B, i)).join();
      out.qOk = [0, 1, 2].every((i) => Math.abs(q(A, i) - 0.25) <= 0.02 && q(B, i) === 1);
      const rgD = G.relicLineRange('xizhu', il, 3);
      out.dark = A.affixes[3].v >= rgD[0] && A.affixes[3].v <= rgD[1] && A.rqv === 2 && B.rqv === 2;
      out.flag = G.xizhuMigrated + ' ' + G.save.xzMig;
      // 同一件旧物品再迁一次：暗域增伤一样（按 uid）
      const a2 = oldItem(0.25, 'xzA');
      G.migrateXizhu(a2);
      out.same = a2.affixes[3].v === A.affixes[3].v;
      // 存回去再读：不再迁移（数值不变）、提示还在（没看过）
      const sig = JSON.stringify(A.affixes);
      G.persist();
      G.loadSave();
      out.stable = JSON.stringify(G.save.equip.helm.affixes) === sig && G.xizhuMigrated === 1;
      // 看过提示：存档里的标记清掉，再读档不再提示
      G.save.tut.xzmig = 1;
      G.save.xzMig = false;
      G.persist();
      G.loadSave();
      out.after = G.xizhuMigrated + ' ' + G.save.xzMig;
      out.fresh = G.rollRelic('xizhu', 62).rqv;
      G.save.bag.length = 0;
      for (const x of keep.bag) G.save.bag.push(x);
      G.save.equip.helm = keep.helm;
      G.save.tut = keep.tut;
      G.save.xzMig = keep.xzMig;
      G.computeStats();
      G.persist();
      return out;
    });
    assert(r.ids === 'life,crit,lifeRegen,darkDmg', '迁移后的词缀行不对：' + JSON.stringify(r));
    assert(r.qOk && r.dark && r.same, '分位 / 新词缀不对：' + JSON.stringify(r));
    assert(r.flag === '2 true' && r.stable && r.after === '0 false' && r.fresh === 2, '只迁一次 / 提示一次不对：' + JSON.stringify(r));
    return '分位 ' + r.qA + ' / ' + r.qB;
  });

  await step('巅峰渊契：熄烛冠 / 双生坠 × 3 个物品等级都合法（isItem 认、存档往返留着）；图标 it-rq-xizhu / it-rq-shuangsheng 画得出来；图鉴 15 行（巅峰的排在最后、写着熄烛者）；不进随机掉落的池子', async () => {
    const r = await ev(() => {
      const out = { bad: [] };
      for (const id of G.RELIC_PINNACLE) {
        const R = G.RELICS[id];
        for (const il of [40, 55, 62]) {
          const it = G.rollRelic(id, il);
          if (!(it.rarity === 4 && it.rq === id && it.slot === R.slot && it.affixes.length === R.lines.length && it.name === R.name)) out.bad.push(id + '@' + il);
        }
      }
      out.pool = G.RELIC_PINNACLE.every((id) => G.RELIC_IDS.indexOf(id) < 0) && G.RELIC_CODEX.length === 15;
      const urls = G.RELIC_PINNACLE.map((id) => G.icons.url('it-rq-' + id));
      out.icons = urls.every((u) => /^data:image\/png;base64,/.test(u) && u.length > 1500) && urls[0] !== urls[1];
      out.key = G.icons.itemKey(G.rollRelic('xizhu', 50));
      out.desc = G.RELICS.xizhu.mechDesc.indexOf('8 米') >= 0 && G.RELICS.xizhu.mechAlt.indexOf('9 米') >= 0 && G.RELICS.shuangsheng.mechDesc.indexOf('交替') >= 0;
      G.save.bag.length = 0;
      G.save.bag.push(G.rollRelic('xizhu', 50), G.rollRelic('shuangsheng', 50));
      G.persist();
      G.loadSave();
      out.kept = G.save.bag.filter((it) => it.rarity === 4).length;
      G.save.bag.length = 0;
      G.ui.open('inv');
      const rows = Array.from(document.querySelectorAll('.cx-row.rq'));
      out.rows = rows.length + ' ' + rows.slice(-2).map((n) => n.dataset.rq).join() + ' ' + /熄烛者/.test(rows[rows.length - 1].textContent);
      G.ui.close();
      return out;
    });
    assert(r.bad.length === 0 && r.pool && r.icons && r.key === 'it-rq-xizhu' && r.desc && r.kept === 2, '巅峰渊契数据 / 图标不对：' + JSON.stringify(r));
    assert(r.rows === '15 xizhu,shuangsheng true', '图鉴不对：' + r.rows);
    return '图鉴 ' + r.rows;
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

  // ------------------------------------------------------------------ 区域地形（网格 + 兼容层）
  // zones-integrate（C）：五个区都换成了新生成器，原来这一步只对 legacy 布局成立（兼容字段 circles / segs 的解析 zoneSd）。
  // 现在每个区做两遍：新生成器的布局和图元精确 sd（W.sdExact，可走 / 挡子弹两套）逐点比；再把生成器临时换回 GEN.legacy，照原来的断言和 zoneSd 比
  await step('区域地形：5 个区的网格判定和精确 sd 逐点一致（新生成器比 W.sdExact、legacy 比解析 zoneSd，各 5000 个点）', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, zs = W.terrain.zoneSd, ZT = W.terrain.ZONE_TERRAIN, out = [];
      let seed = 4242;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const pads = [0, 0.5, 0.4, -0.4, 1, -0.3, 0.6];
      const probe = (zone, ref, refShot) => {
        const b = zone.bounds;
        let bad = 0, near = 0, maxErr = 0, shotBad = 0, shotN = 0;
        for (let i = 0; i < 5000; i++) {
          const x = b.minX - 5 + rnd() * (b.maxX - b.minX + 10), z = b.minZ - 5 + rnd() * (b.maxZ - b.minZ + 10), pad = pads[i % pads.length];
          const a = ref(x, z);
          if (a > -3.8 && a < 4.6) maxErr = Math.max(maxErr, Math.abs(W.sdAt(x, z) - a));
          if (Math.abs(a - pad) < 0.03) near++;
          else if (W.walkable(x, z, pad) !== a >= pad) bad++;
          if (refShot) {
            const sa = refShot(x, z);
            if (Math.abs(sa - pad) >= 0.03 && Math.abs(a - pad) >= 0.03) {
              shotN++;
              if (W.shotFree(x, z, pad) !== sa >= pad) shotBad++;
            }
          }
        }
        return { bad, near, maxErr: +maxErr.toFixed(3), band: +zone.map.band.toFixed(3), shotBad, shotN, ms: +zone.map.ms.toFixed(1), haz: zone.map.hazAny, shot: zone.map.sdShot !== zone.map.sd };
      };
      for (let zi = 0; zi < G.ZONES.length; zi++) {
        G.enterZone(zi, 0);
        const zone = G.state.zone, pr = zone.map.pr, L = G.debug.layout();
        const cust = probe(zone, (x, z) => W.sdExact(x, z), (x, z) => W.terrain.exactSd(pr, x, z, true));
        cust.gen = L.gen;
        cust.shotCut = (zone.spec.cuts || []).some((c) => c.mat === W.MAT.VOID || c.mat === W.MAT.WATER || c.mat === W.MAT.LAVA) || [W.MAT.VOID, W.MAT.WATER, W.MAT.LAVA].indexOf(zone.spec.outside) >= 0; // zones-polish：frost 外面改成 WATER，区域外面是虚空 / 水 / 熔岩都算透弹
        // legacy：临时把这一区的生成器换回 GEN.legacy（不固定种子时直接用 Math.random，和改版前一样）
        const gen0 = ZT[zone.def.id].gen;
        ZT[zone.def.id].gen = W.terrain.GEN.legacy;
        let leg;
        try {
          G.enterZone(zi, 0);
          leg = probe(G.state.zone, (x, z) => zs(G.state.zone, x, z), null);
          leg.gen = G.debug.layout().gen;
        } finally {
          ZT[zone.def.id].gen = gen0;
        }
        out.push({ id: zone.def.id, cust, leg });
      }
      G.enterZone(0, 0);
      return out;
    });
    for (const z of r) {
      const c = z.cust, l = z.leg;
      assert(c.gen === 'custom' && l.gen === 'legacy', z.id + '：生成器不对：' + JSON.stringify(z));
      assert(c.bad === 0, z.id + '：网格 walkable 和图元精确 sd 判定不一致 ' + c.bad + ' 处：' + JSON.stringify(c));
      assert(c.shotBad === 0 && c.shotN > 3000, z.id + '：W.shotFree 和挡子弹的精确 sd 判定不一致 ' + c.shotBad + ' 处：' + JSON.stringify(c));
      assert(c.maxErr <= c.band, z.id + '：网格 sd 误差超过精修带宽：' + JSON.stringify(c));
      assert(c.shot === c.shotCut, z.id + '：有透弹挖空（虚空 / 深水 / 熔岩）就应有单独的 sdShot：' + JSON.stringify(c));
      assert(l.bad === 0, z.id + '：legacy 布局下网格 walkable 和解析 zoneSd 判定不一致 ' + l.bad + ' 处：' + JSON.stringify(l));
      assert(l.maxErr <= l.band, z.id + '：legacy 布局下网格 sd 误差超过精修带宽：' + JSON.stringify(l));
      assert(l.haz === 0 && !l.shot, z.id + '：legacy 布局不该有危险区 / 透弹挖空：' + JSON.stringify(l));
    }
    return r.map((z) => z.id + ' 误差 ' + z.cust.maxErr + ' / legacy ' + z.leg.maxErr + ' 光栅化 ' + z.cust.ms + 'ms').join('，');
  });

  await step('区域地形：同一种子生成的布局说明哈希相同，固定种子进区布局不变', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, out = { same: true, diff: 0, ids: [] };
      for (const def of G.ZONES) {
        const a = W.genLayout(def.id, 20251118), b = W.genLayout(def.id, 20251118), c = W.genLayout(def.id, 20251119);
        if (a.hash !== b.hash || W.specHash(a.spec) !== a.hash) out.same = false;
        if (a.hash !== c.hash) out.diff++;
        out.ids.push(def.id + ':' + a.hash);
      }
      G.debug.zoneSeed(777);
      G.enterZone(1, 0);
      const l1 = G.debug.layout();
      G.enterZone(1, 0);
      const l2 = G.debug.layout();
      const kinds = (l) => l.rooms.reduce((o, rm) => ((o[rm.kind] = (o[rm.kind] || 0) + 1), o), {});
      out.pinned = { seed: l1.seed, h1: l1.hash, h2: l2.hash, rooms: l1.rooms.length, path: l1.path.length, packs: l1.packs.length, chests: l1.chests.length, kinds: kinds(l1), gen: l1.gen };
      out.unpinned = G.debug.zoneSeed(null);
      const tp = G.debug.tpRoom(2);
      out.tp = !!tp && G.world.walkable(G.player.x, G.player.z, 1);
      G.enterZone(0, 0);
      const s1 = G.debug.layout();
      G.enterZone(0, 0);
      const s2 = G.debug.layout();
      out.seed0 = s1.seed;
      out.seed1 = s2.seed;
      out.fresh = s1.hash !== s2.hash;
      return out;
    });
    assert(r.same, '同一种子两次生成的哈希不同：' + JSON.stringify(r));
    assert(r.diff === r.ids.length, '换了种子布局应当不同：' + JSON.stringify(r));
    // zones-integrate（C）：原来比的是第 1 区 legacy 布局的数（11 / 11 / 8）。现在第 1 区是霜骨沼泽的岛链（design §3.2）：
    // 关键路径 = 起点岛 + 4 个岛 + 场地岛 + 5 段连接 = 11，3 个藏宝小岛（各一段死路栈道），宝箱 2 个，怪群 10–14 个
    const P = r.pinned, K = P.kinds;
    assert(P.seed === 777 && P.gen === 'custom' && P.h1 === P.h2, '固定种子进区两次布局应一样：' + JSON.stringify(r));
    // zones-polish：霜骨沼泽加长到 ×1.6（岛 4 → 6–7、旁支 3 → 4–5、宝箱 2 → 3、怪群 10–14 → 16–24）；关键路径 = 起点 + 岛 + 场地 + 其间的连接 = 2 × 岛数 + 3
    assert(K.start === 1 && K.arena === 1 && K.room >= 6 && K.room <= 7 && P.path === 2 * K.room + 3 && K.side >= 4 && K.side <= 5 && P.chests === 3 && P.packs >= 16 && P.packs <= 24, '固定种子的第 1 区布局应符合设计（岛 6–7、关键路径 = 2 × 岛数 + 3、旁支 4–5、宝箱 3、怪群 16–24）：' + JSON.stringify(P));
    // 不固定种子：每次进区都换布局（owner 决定 10），种子是新取的
    assert(r.unpinned === null && typeof r.seed0 === 'number' && r.seed0 !== 777 && r.seed1 !== r.seed0 && r.fresh && r.tp, 'zoneSeed(null) 后应恢复每次进区换布局，tpRoom 应落在房间里：' + JSON.stringify(r));
    return r.ids.join(' ');
  });

  await step('区域地形：W.genLayout 对 5 个区 × 20 个种子都通过校验', async () => {
    const r = await ev(() => {
      const W = G.world, bad = [], t0 = performance.now();
      let n = 0, slow = 0;
      for (const def of G.ZONES) {
        for (let s = 1; s <= 20; s++) {
          const g = W.genLayout(def.id, s * 104729);
          n++;
          slow = Math.max(slow, g.ms);
          if (!g.ok) bad.push(def.id + '#' + g.seed + '：' + g.why.join('；'));
        }
      }
      return { n, bad, ms: Math.round(performance.now() - t0), slow: +slow.toFixed(1) };
    });
    assert(r.n === 100 && !r.bad.length, '有种子没通过校验：' + r.bad.slice(0, 5).join(' | '));
    return r.n + ' 个布局，共 ' + r.ms + 'ms，最慢 ' + r.slow + 'ms';
  });

  await step('区域地形：W.shotFree 和投射物照样被测试插的假墙挡住', async () => {
    await ev(() => T.lane());
    const r = await ev(() => {
      const P = G.player, W = G.world, S = G.state;
      const ow = W.walkable, wallX = P.x + 3;
      const out = { before: W.shotFree(wallX, P.z, -0.4) };
      W.walkable = function (x, z, pad) { return Math.abs(x - wallX) < 0.5 ? false : ow.call(W, x, z, pad); };
      try {
        out.wall = W.shotFree(wallX, P.z, -0.4);
        out.side = W.shotFree(wallX - 1.5, P.z, -0.4);
        const n0 = S.projectiles.length;
        G.spawnProjectile({ owner: 'p', x: P.x + 0.5, z: P.z, dx: 1, dz: 0, ctx: G.skillCtx('ember'), color: 0xff8a3c });
        const p = S.projectiles[S.projectiles.length - 1];
        out.spawned = S.projectiles.length === n0 + 1;
        let maxX = -1e9, gone = false;
        for (let i = 0; i < 60 && !gone; i++) {
          G.tick(1 / 60);
          if (S.projectiles.indexOf(p) < 0) gone = true;
          else maxX = Math.max(maxX, p.x);
        }
        out.gone = gone;
        out.crossed = maxX > wallX + 0.5;
      } finally {
        W.walkable = ow;
      }
      out.after = W.shotFree(wallX, P.z, -0.4);
      return out;
    });
    assert(r.before && r.after, '撤掉假墙后应能通过：' + JSON.stringify(r));
    assert(!r.wall && r.side, 'W.shotFree 应被假墙挡住、墙边照常通过：' + JSON.stringify(r));
    assert(r.spawned && r.gone && !r.crossed, '投射物应在假墙前销毁：' + JSON.stringify(r));
  });

  await step('宝箱：走过去自动打开，掉落约等于一只精英，只开一次；小地图上是金色方块，打开后变暗', async () => {
    await ev(() => T.lane());
    const r = await ev(() => {
      const P = G.player, S = G.state, W = G.world;
      for (const l of S.loot) W.removeMesh(l.mesh);
      S.loot.length = 0;
      const cur0 = Object.values(G.save.cur).reduce((a, b) => a + b, 0), bag0 = G.save.bag.length;
      const c = G.debug.chest(P.x + 8, P.z);
      W.render();
      // 小地图上宝箱那一块 3×3 里最「金」的像素（离玩家的圆点 8 m，不会被盖住）
      const px = () => {
        const m = W.minimapXY(c.x, c.z);
        let best = null;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const q = W.minimapPixel(Math.round(m.x) + dx, Math.round(m.y) + dy);
          if (!best || q[0] + q[1] - q[2] > best[0] + best[1] - best[2]) best = q;
        }
        return best;
      };
      const before = px();
      const open0 = c.open;
      for (let i = 0; i < 10; i++) G.tick(1 / 60); // 还没走到：不会开
      const still = c.open;
      T.tp(c.x - 0.9, c.z);
      for (let i = 0; i < 30; i++) G.tick(1 / 60);
      const items = S.loot.filter((l) => l.kind === 'item').length + G.save.bag.length - bag0; // 普通物品可能被「自动拾取」直接收进背包
      const curSum = () => Object.values(G.save.cur).reduce((a, b) => a + b, 0);
      const cur = S.loot.filter((l) => l.kind === 'cur').length + curSum() - cur0;
      const total = () => S.loot.length + curSum() - cur0 + G.save.bag.length - bag0; // 地上的 + 已经拾取的
      const n1 = total();
      T.tp(c.x - 3, c.z);
      for (let i = 0; i < 5; i++) G.tick(1 / 60);
      T.tp(c.x - 0.9, c.z);
      for (let i = 0; i < 30; i++) G.tick(1 / 60);
      const again = total() === n1;
      T.tp(c.x - 6, c.z); // 小地图上玩家的圆点别盖住宝箱
      W.render();
      const after = px();
      return { open0, still, open: c.open, items, cur, again, stats: S.stats.chests, before, after };
    });
    assert(!r.open0 && !r.still && r.open, '宝箱应在走到跟前时才打开：' + JSON.stringify(r));
    assert(r.items === 2 && r.cur >= 1, '宝箱掉落应和精英一样（2 件装备 + 至少 1 个通货）：' + JSON.stringify(r));
    assert(r.again && r.stats === 1, '打开过的宝箱不应再掉东西：' + JSON.stringify(r));
    assert(r.before[0] > 200 && r.before[1] > 170 && r.after[0] < 190, '小地图上的宝箱应是金色、打开后变暗：' + JSON.stringify(r));
    return '掉落 ' + r.items + ' 件装备 + ' + r.cur + ' 个通货';
  });

  await step('宝箱：点一下也能打开（7 m 以内，不同时施法），远了提示走近；附近没有掉落时 F 键打开最近的宝箱', async () => {
    // zones-polish 加：点击打开和点掉落名牌一样
    const a = await ev(() => {
      G.debug.hold(true);
      G.debug.zoneSeed(20251118);
      G.enterZone(0, 0);
      G.debug.zoneSeed(null);
      for (const e of G.state.enemies) e.awake = false;
      T.tp(0, 0);
      T.clearLoot();
      const c = G.debug.chest(3.5, 0.6), far = G.debug.chest(2.2, -7.4);
      T.settle();
      G.world.render();
      const p = G.world.project(c.x, 0.55, c.z), q = G.world.project(far.x, 0.55, far.z);
      return { pt: { x: Math.round(p.x), y: Math.round(p.y) }, far: { x: Math.round(q.x), y: Math.round(q.y), ok: q.ok && q.y > 40 && q.y < innerHeight - 160 } };
    });
    await page.mouse.click(a.pt.x, a.pt.y);
    const b = await ev(() => {
      const ch = G.state.zone.chests, P = G.player;
      return { open: ch[ch.length - 2].open, cast: !!P.cast, tap: G.input.tap[0], held: G.input.mouse.b[0], loot: G.state.loot.length };
    });
    await page.mouse.click(a.far.x, a.far.y);
    const c = await ev(() => {
      const ch = G.state.zone.chests, far = ch[ch.length - 1];
      const r = { farOpen: far.open, toast: T.toasts().includes('走近一点') };
      // F 键：清掉地上的掉落，站到远处那个宝箱 3 m 以内
      T.clearLoot();
      T.tp(far.x - 2.4, far.z + 0.6);
      return r;
    });
    await page.keyboard.press('KeyF');
    const d = await ev(() => {
      const ch = G.state.zone.chests;
      const r = { fOpen: ch[ch.length - 1].open, loot: G.state.loot.length };
      G.enterZone(0, 0);
      return r;
    });
    assert(a.far.ok, '远处那个宝箱应在画面里：' + JSON.stringify(a));
    assert(b.open && b.loot > 0, '点宝箱应当打开并掉东西：' + JSON.stringify(b));
    assert(!b.cast && !(b.tap > 0) && !b.held, '点宝箱时不应同时施法：' + JSON.stringify(b));
    assert(!c.farOpen && c.toast, '7 m 以外点宝箱不应打开，应提示走近：' + JSON.stringify(c));
    assert(d.fOpen && d.loot > 0, '附近没有掉落时 F 键应打开 3.5 m 内的宝箱：' + JSON.stringify(d));
    return '点击打开 ✓、远处提示走近 ✓、F 键打开 ✓';
  });

  await step('小地图：按地形网格画出来（可走处路面色、岩壁外是底色、首领场地有主题色轮廓），窗口变化后重画', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, out = [];
      for (let zi = 0; zi < G.ZONES.length; zi++) {
        G.enterZone(zi, 0);
        const z = G.state.zone, b = z.bounds, path = new THREE.Color(z.def.path), acc = new THREE.Color(z.def.accent);
        const pick = (x, zz) => { const m = W.minimapXY(x, zz); return W.minimapPixel(m.x, m.y, true); };
        const start = pick(z.start.x, z.start.z);
        // 找一个离可走区域很远的点（sd < -6）当「岩壁外」
        let far = null;
        for (let k = 0; k < 400 && !far; k++) {
          const x = b.minX + ((k * 37) % 100) / 100 * (b.maxX - b.minX), zz = b.minZ + ((k * 61) % 100) / 100 * (b.maxZ - b.minZ);
          if (W.sdExact(x, zz) < -4.4) far = pick(x, zz);
        }
        // 场地轮廓（zones-integrate 改）：原来只沿门的反方向一条线找，1 像素宽的 4 连通阶梯轮廓会从像素角漏过去（legacy 布局也偶尔挂）。
        // 现在从场地中心往 32 个方向各打一条射线（0.5·bossR 到 bossR + 6 m），每个采样点再往切向各挪 0.6 像素，
        // 统计有多少个方向碰到主题色的轮廓：轮廓应把场地整圈围住
        const m0 = W.minimapXY(0, 0), m1 = W.minimapXY(1, 0), pxm = Math.abs(m1.x - m0.x) || 1;
        let ring = 0, rays = 0;
        for (let k = 0; k < 32; k++) {
          const a = (k / 32) * Math.PI * 2, ux = Math.sin(a), uz = Math.cos(a);
          let best = 0;
          for (let d = z.bossR * 0.5; d <= z.bossR + 6 && best <= 200; d += 0.5 / pxm) {
            for (const t of [0, 0.6, -0.6]) {
              const q = pick(z.bossPos.x + ux * d - uz * (t / pxm), z.bossPos.z + uz * d + ux * (t / pxm));
              const sim = 255 - (Math.abs(q[0] - acc.r * 255) + Math.abs(q[1] - acc.g * 255) + Math.abs(q[2] - acc.b * 255)) / 3;
              best = Math.max(best, sim);
            }
          }
          ring = Math.max(ring, best);
          if (best > 200) rays++;
        }
        const pathD = (Math.abs(start[0] - path.r * 255) + Math.abs(start[1] - path.g * 255) + Math.abs(start[2] - path.b * 255)) / 3;
        const mi = W.minimapInfo(); // zones-polish：区域加长以后小地图不再整张缩进 172 px，最小每米 0.9 像素，超出时以玩家为中心截取
        out.push({ id: z.def.id, start, pathD: Math.round(pathD), far, ring: Math.round(ring), rays, s: +mi.s.toFixed(2), win: mi.win });
      }
      G.enterZone(0, 0);
      const m = W.minimapXY(0, 0), p0 = W.minimapPixel(m.x, m.y, true);
      W.resize();
      const p1 = W.minimapPixel(m.x, m.y, true);
      return { out, redraw: p0.join() === p1.join() && p1[3] > 200 };
    });
    for (const z of r.out) {
      assert(z.start[3] > 240 && z.pathD < 40, z.id + '：起点应画成路面色：' + JSON.stringify(z));
      assert(z.far && z.far[0] < 30 && z.far[1] < 30 && z.far[2] < 30, z.id + '：岩壁外应是底色：' + JSON.stringify(z));
      assert(z.ring > 200 && z.rays >= 28, z.id + '：首领场地应有一整圈主题色轮廓（32 个方向至少 28 个碰到）：' + JSON.stringify(z));
      assert(z.s >= 0.9, z.id + '：小地图每米应不少于 0.9 像素（太大的区域改成截取）：' + JSON.stringify(z));
    }
    assert(r.redraw, '窗口变化后小地图应重画且不变：' + JSON.stringify(r));
    return r.out.map((z) => z.id + ' 路面差 ' + z.pathD + ' 轮廓 ' + z.ring + '（' + z.rays + '/32）').join('，');
  });
  await step('区域 ash 布局：20 个种子都通过校验 + 进区刷怪正常 + 首领门外重生；熔岩河挡路不挡子弹，浅滩两边灼烧（玩家和小怪都烧）', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, P = G.player, S = G.state, out = { bad: [], n: 0 };
      for (let s = 1; s <= 20; s++) {
        const g = W.genLayout('ash', s * 7919 + 13);
        out.n++;
        if (!g.ok) out.bad.push(g.seed + '：' + g.why.join('；'));
      }
      const god0 = !!P.god;
      G.debug.god(true);
      G.debug.zoneSeed(20251118);
      G.enterZone(0, 0);
      const z = S.zone, mobs = S.enemies.filter((e) => !e.dead && !e.isBoss);
      out.custom = !z.spec.legacy && z.feats.some((f) => f.kind === 'river');
      // zones-polish：区域加长到 ×1.6：关键路径 7 个房间、旁支 3 个、两道熔岩（河 + 沟），两座石桥都能走
      out.size = { path: z.rooms.filter((q) => q.path && q.kind === 'room').length, sides: z.rooms.filter((q) => q.kind === 'side').length,
        rivers: z.feats.filter((q) => q.kind === 'river').length, bridges: z.feats.filter((q) => q.kind === 'bridge').map((q) => W.walkable(q.x, q.z, 0.6)) };
      out.mobs = mobs.length;
      out.elites = mobs.filter((e) => e.elite).length;
      out.legal = mobs.every((e) => W.walkable(e.x, e.z, 0) && Math.hypot(e.x - z.start.x, e.z - z.start.z) >= 12);
      out.bossIn = S.enemies.some((e) => e.isBoss && W.inArena(e.x, e.z));
      out.chests = z.chests.length;
      // 熔岩河：桥边 4 m（还在颈口里）是熔岩——走不过去、子弹和视线能过；桥面能走
      const f = (k) => z.feats.find((q) => q.kind === k), br = f('bridge'), fd = f('ford');
      const lat = (q, d) => [q.x + Math.cos(q.ang) * d, q.z - Math.sin(q.ang) * d];
      const lv = lat(br, 4);
      out.lava = { walk: W.walkable(lv[0], lv[1], 0), shot: W.shotFree(lv[0], lv[1], 0), mat: W.matAt(lv[0], lv[1]) === W.MAT.LAVA };
      out.bridge = W.walkable(br.x, br.z, 0.6);
      // 浅滩：中间的硬壳安全，两条边是灼烧；站在边上的小怪和玩家都会掉血
      const edge = lat(fd, fd.w / 2 - 0.5);
      out.ford = { mid: W.hazardAt(fd.x, fd.z) & W.HAZ.burn, edge: W.hazardAt(edge[0], edge[1]) & W.HAZ.burn, walk: W.walkable(fd.x, fd.z, 0.6) };
      // 小怪：玩家站在桥上（离浅滩 20 m 开外，怪不会醒、不会走开），怪睡在灼烧边上
      const e = G.spawnMob('husk', edge[0], edge[1], z.level, { awake: false });
      const hp0 = e.hp;
      T.tp(br.x, br.z);
      for (let i = 0; i < 70; i++) G.tick(1 / 60);
      const mob = hp0 - e.hp;
      // 玩家：站到灼烧边上
      T.tp(edge[0], edge[1]);
      G.debug.god(false);
      P.iframe = 0;
      const life0 = P.life;
      for (let i = 0; i < 70; i++) G.tick(1 / 60);
      out.burn = { mob, player: life0 - P.life, asleep: !e.awake };
      G.debug.god(true);
      // 首领门外重生：首领醒着时倒下，重生在场地门外（离场地边缘 2）
      G.debug.tpBoss();
      let t = 0;
      while (!S.boss.awake && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      G.debug.god(false);
      P.iframe = 0;
      G.hurtPlayer(1e9, 'phys');
      out.died = P.dead;
      G.debug.step(4.2);
      out.door = { off: Math.hypot(P.x - z.bossPos.x, P.z - z.bossPos.z) - z.bossR, atDoor: Math.hypot(P.x - z.bossDoor.x, P.z - z.bossDoor.z), walk: W.walkable(P.x, P.z, 0.5), alive: !P.dead };
      G.debug.god(god0);
      G.debug.zoneSeed(null);
      G.enterZone(0, 0);
      return out;
    });
    assert(r.n === 20 && !r.bad.length, '有种子没通过校验：' + r.bad.slice(0, 5).join(' | '));
    assert(r.custom, '第 0 区应当用新的生成器（有熔岩河），却退回了 legacy：' + JSON.stringify(r));
    assert(r.mobs >= 80 && r.elites <= 6 && r.legal && r.bossIn && r.chests === 3, '刷怪 / 宝箱不对：' + JSON.stringify(r));
    assert(r.size.path === 7 && r.size.sides === 3 && r.size.rivers === 2 && r.size.bridges.length === 2 && r.size.bridges.every(Boolean), '加长后的布局不对（关键路径 7 个房间、旁支 3 个、河和沟各一道、两座桥能走）：' + JSON.stringify(r.size));
    assert(!r.lava.walk && r.lava.shot && r.lava.mat && r.bridge, '熔岩河应挡路、不挡子弹，桥面应能走：' + JSON.stringify(r));
    assert(!r.ford.mid && r.ford.edge && r.ford.walk && r.burn.mob > 0 && r.burn.player > 0, '浅滩两边应灼烧（玩家和小怪都掉血），中间安全：' + JSON.stringify(r));
    assert(r.died && Math.abs(r.door.off - 2) < 0.01 && r.door.atDoor < 0.01 && r.door.walk && r.door.alive, '首领战里倒下应重生在场地门外：' + JSON.stringify(r.door));
    return r.n + ' 个种子都过；怪 ' + r.mobs + '（精英 ' + r.elites + '）、宝箱 ' + r.chests + '；灼烧 怪 -' + Math.round(r.burn.mob) + ' 玩家 -' + Math.round(r.burn.player);
  });

  await step('区域 frost 布局：20 个种子都通过校验 + 进区刷怪正常 + 首领门外重生；浅水 / 裂开的薄冰减速，薄冰有预警；深水挡人不挡子弹', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, out = { bad: [] };
      // 20 个种子：校验通过、是新生成器（不是 legacy）、关键路径 6–7 个岛、4–5 个旁支 3 个宝箱、精英 ≤ 6（关键路径 ≤ 5，精英旁支正好 1 个）、
      // 每个房间的怪物等级按 lvFor 折算、2 块薄冰、有浅水、场地 4 根柱子（size-frost：原来 3 个旁支 2 个宝箱、精英 ≤ 4）
      for (let s = 1; s <= 20; s++) {
        const g = W.genLayout('frost', s * 7919 + 13), sp = g.spec;
        const why = g.ok ? [] : g.why.slice();
        if (sp.legacy) why.push('退回了 legacy');
        else {
          const nI = sp.rooms.filter((rm) => rm.kind === 'room').length, nSide = sp.rooms.filter((rm) => rm.kind === 'side').length;
          if (nI < 6 || nI > 7) why.push('关键路径的岛不是 6–7 个');
          if (nSide < 4 || nSide > 5) why.push('旁支不是 4–5 个');
          if (sp.chests.length !== 3) why.push('宝箱不是 3 个');
          if (sp.packs.filter((p) => p.elite).length > 6) why.push('精英超过 6');
          if (sp.packs.filter((p) => p.elite && sp.rooms[p.room].kind !== 'side').length > 5) why.push('关键路径的精英超过 5');
          if (sp.packs.filter((p) => p.elite && sp.rooms[p.room].kind === 'side').length !== 1) why.push('精英旁支不是 1 个');
          if (sp.rooms.some((rm) => rm.lv !== W.terrain.lvFor(rm.kind === 'side' ? rm.order - 1 : rm.order, nI))) why.push('房间的怪物等级没按 lvFor 折算');
          if (sp.haz.filter((h) => h.kind === 'thin').length !== 2) why.push('薄冰不是 2 块');
          if (!sp.haz.some((h) => h.kind === 'slow')) why.push('没有浅水');
          if (sp.cuts.filter((c) => c.mat === W.MAT.WALL && c.prim.r === 0.8).length !== 4) why.push('场地柱子不是 4 根');
        }
        if (why.length) out.bad.push(g.seed + '：' + why.join('；'));
      }
      // 固定种子进区
      G.debug.god(true);
      G.debug.zoneSeed(4242);
      G.enterZone(1, 0);
      const S = G.state, P = G.player, z = S.zone, L = G.debug.layout();
      const mobs = S.enemies.filter((e) => !e.isBoss);
      out.zone = {
        id: z.def.id, gen: L.gen, n: mobs.length, elites: mobs.filter((e) => e.elite).length,
        bad: mobs.filter((e) => !W.walkable(e.x, e.z, 0) || Math.hypot(e.x - z.start.x, e.z - z.start.z) < 12).length,
        types: Array.from(new Set(mobs.map((e) => e.type))).every((t) => z.def.mobs.includes(t)),
        boss: S.boss && S.boss.bossKind, bossIn: !!S.boss && W.inArena(S.boss.x, S.boss.z), chests: z.chests.length,
      };
      // 深水：起点背面 r = 9.5 处是水，不能走、子弹能过
      const c1 = z.circles[1], back = Math.atan2(z.start.x - c1.x, z.start.z - c1.z);
      const wx = z.start.x + Math.sin(back) * 9.5, wz = z.start.z + Math.cos(back) * 9.5;
      out.water = { walk: W.walkable(wx, wz, 0), shot: W.shotFree(wx, wz, 0) };
      // 走 0.25 秒的位移（按住 D），用来比较减速
      const walk = (x, zz) => {
        T.tp(x, zz);
        G.debug.step(0.05);
        G.input.keys.KeyD = true;
        G.debug.step(0.25);
        G.input.keys.KeyD = false;
        return Math.hypot(P.x - x, P.z - zz);
      };
      // 量减速时把怪清掉（别挡路），量完按同一个种子重进
      G.clearEnemies();
      const thinRooms = z.feats.filter((f) => f.kind === 'thin').map((f) => f.room);
      const core = z.rooms[z.path.find((id) => z.rooms[id].kind === 'room' && !thinRooms.includes(id))].core;
      const base = walk(core.x, core.z);
      const sh = z.feats.find((f) => f.kind === 'shallow');
      out.slow = { base: +base.toFixed(2), shallow: sh ? +(walk(sh.x, sh.z) / base).toFixed(2) : null, haz: sh ? W.hazardAt(sh.x, sh.z) : -1 };
      // 薄冰：站着不动 1.2 秒就裂开（外观状态同步、裂纹变亮），裂开后在上面走会减速；离开 4 秒多复原
      const th = z.feats.find((f) => f.kind === 'thin');
      T.tp(core.x, core.z);
      G.debug.step(0.1);
      W.update(1 / 60);
      const s0 = W.frostState(), i0 = s0.ids.findIndex((id) => id === W.hazPrimAt(th.x, th.z, 'thin')), k0 = s0.k[i0];
      T.tp(th.x, th.z);
      G.debug.step(0.7);
      W.update(1 / 60);
      const s1 = W.frostState(), k1 = s1.k[i0];
      G.debug.step(0.6);
      W.update(1 / 60);
      const s2 = W.frostState();
      out.thin = { id: s0.ids[i0], tid: s1.tid, cracked: s2.cracked.includes(s0.ids[i0]), rest: +k0.toFixed(2), half: +k1.toFixed(2), crackedK: +s2.k[i0].toFixed(2), speed: +(walk(th.x - 0.6, th.z) / base).toFixed(2) };
      T.tp(core.x, core.z);
      G.debug.step(4.6);
      W.update(1 / 60);
      out.thin.back = !W.frostState().cracked.length;
      // 首领战里倒下：重生在门外（离场地中心 bossR + 2，在门的颈口上），首领复位
      G.enterZone(1, 0);
      const b = S.boss;
      G.debug.tpBoss();
      let t = 0;
      while (!b.awake && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      out.woke = b.awake;
      G.debug.god(false);
      P.life = 1;
      let dt = 0;
      while (!P.dead && dt < 40) { G.tick(1 / 60); dt += 1 / 60; }
      out.dead = P.dead;
      G.debug.step(4.2);
      out.respawn = {
        alive: !P.dead, door: +(Math.hypot(P.x - S.zone.bossPos.x, P.z - S.zone.bossPos.z) - S.zone.bossR).toFixed(3), walk: W.walkable(P.x, P.z, 0.5), inArena: W.inArena(P.x, P.z),
        bossHome: +Math.hypot(b.x - S.zone.bossPos.x, b.z - S.zone.bossPos.z).toFixed(3), bossAwake: b.awake, bossFull: b.hp === b.maxHp,
      };
      G.debug.god(true);
      G.debug.zoneSeed(null);
      G.enterZone(0, 0);
      return out;
    });
    assert(!r.bad.length, '有种子不合格：' + r.bad.slice(0, 4).join(' | '));
    const Z = r.zone;
    assert(Z.id === 'frost' && Z.gen === 'custom' && Z.boss === 'weaver' && Z.bossIn && Z.chests === 3, '进区布局不对：' + JSON.stringify(Z));
    // size-frost：区域加长后怪群约 ×1.6–1.8，怪数上下限照 ×1.6 放（原来 40–70、精英 1–4）
    // zones-balance：每群人数 ×1.25，上下限跟着 ×1.25（64–112 → 80–140）
    assert(Z.n >= 80 && Z.n <= 140 && Z.elites >= 1 && Z.elites <= 6 && Z.bad === 0 && Z.types, '刷怪不对：' + JSON.stringify(Z));
    assert(!r.water.walk && r.water.shot, '深水应挡人、不挡子弹：' + JSON.stringify(r.water));
    assert(r.slow.haz & 1 && r.slow.shallow > 0.55 && r.slow.shallow < 0.75, '浅水应减速到约 0.65：' + JSON.stringify(r.slow));
    const th = r.thin;
    assert(th.tid === th.id && th.half > th.rest + 0.2 && th.cracked && th.crackedK > th.rest + 0.3, '薄冰的预警 / 裂开状态不对：' + JSON.stringify(th));
    assert(th.speed > 0.55 && th.speed < 0.75 && th.back, '裂开的薄冰应减速、离开后复原：' + JSON.stringify(th));
    const R = r.respawn;
    assert(r.woke && r.dead && R.alive && Math.abs(R.door - 2) < 0.01 && R.walk && !R.inArena, '首领战倒下应重生在场地门外：' + JSON.stringify(r));
    assert(R.bossHome < 0.01 && !R.bossAwake && R.bossFull, '首领没有复位：' + JSON.stringify(R));
    return '怪 ' + Z.n + '（精英 ' + Z.elites + '），浅水 ×' + r.slow.shallow + '，薄冰 ×' + th.speed + '，门距 ' + R.door;
  });

  await step('区域 storm 布局：20 个种子都通过校验 + 进区刷怪正常 + 首领门外重生；雷枢先长条预警、再同时打到玩家和小怪', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, S = G.state, P = G.player, out = { bad: [], seeds: 0 };
      const zi = G.ZONES.findIndex((z) => z.id === 'storm');
      // 20 个种子：校验通过、是本区自己的生成器（有 storm 字段），关键路径大厅 6–7 个、旁支 3–5 个，怪 72–104 只（size-storm：区域加长 ×1.6），
      // 精英 1–6（关键路径 ≤ 5，旁支保底 1）、宝箱 3、至多一个关键路径大厅没有伏击群；每个房间的怪物等级偏移 lv = lvFor(order, 大厅数)，旁支取父大厅
      const lvFor = W.terrain.lvFor;
      for (let s = 1; s <= 20; s++) {
        const g = W.genLayout('storm', s * 7919 + 3), sp = g.spec;
        out.seeds++;
        if (!g.ok || !sp.storm) { out.bad.push(s + '：' + g.why.join('；')); continue; }
        const mobs = sp.packs.reduce((a, p) => a + (Array.isArray(p.n) ? (p.n[0] + p.n[1]) / 2 : p.n), 0);
        const el = sp.packs.filter((p) => p.elite).length, halls = sp.rooms.filter((rm) => rm.kind === 'room'), sides = sp.rooms.filter((rm) => rm.kind === 'side');
        const pel = sp.packs.filter((p) => p.elite && sp.rooms[p.room].kind !== 'side').length, sel = sp.packs.some((p) => p.elite && sp.rooms[p.room].kind === 'side');
        const amb = halls.filter((h) => sp.packs.some((p) => p.ambush && p.room === h.id)).length, nP = halls.length;
        const lvOk = sp.rooms.every((rm) => rm.lv === lvFor(rm.kind === 'side' ? rm.order - 1 : rm.order, nP)) && sp.rooms[sp.arena.room].lv === 2 && halls.every((h) => h.order > 1 || h.lv === 0);
        if (mobs < 72 || mobs > 104 || el < 1 || el > 6 || pel > 5 || !sel || sp.chests.length !== 3 || nP < 6 || nP > 7 || sides.length < 3 || sides.length > 5 || amb < nP - 1 || !lvOk) {
          out.bad.push(s + '：怪 ' + mobs + ' 精英 ' + el + '（关键路径 ' + pel + '）宝箱 ' + sp.chests.length + ' 大厅 ' + nP + ' 旁支 ' + sides.length + ' 伏击 ' + amb + ' lv ' + lvOk);
        }
      }
      // 固定种子进区。异兆关掉：随机掷到的游荡者会在雷枢边上醒来，把关了无敌的玩家打倒，倒下时雷枢不运转（约 3% 的概率整步失败）
      G.debug.zoneSeed(4242);
      G.debug.noEnc = true;
      G.enterZone(zi, 0);
      const z = S.zone, info = G.debug.layout();
      out.zone = {
        gen: info.gen, n: S.enemies.filter((e) => !e.isBoss).length, boss: !!S.boss, chests: z.chests.length,
        bad: S.enemies.filter((e) => !W.walkable(e.x, e.z, 0) || Math.hypot(e.x - z.start.x, e.z - z.start.z) < 12).length,
        elites: S.enemies.filter((e) => e.elite).length, doorGap: Math.hypot(z.bossDoor.x - z.bossPos.x, z.bossDoor.z - z.bossPos.z) - z.bossR,
        doorWalk: W.walkable(z.bossDoor.x, z.bossDoor.z, 0.5), wallMat: W.matAt(z.bossPos.x + 40, z.bossPos.z + 40) === W.MAT.WALL,
      };
      // 雷枢：机关厅那一对。玩家站在雷线上、一只游魂也站在上面
      const f = z.feats.find((q) => q.kind === 'node');
      const mx = (f.ax + f.bx) / 2, mz = (f.az + f.bz) / 2;
      G.clearEnemies();
      T.tp(mx, mz);
      P.iframe = 0;
      G.debug.god(false);
      P.life = P.maxLife;
      const husk = G.spawnMob('husk', mx + (f.bx - f.ax) * 0.2, mz + (f.bz - f.az) * 0.2, 1, { awake: true });
      husk.hp = husk.maxHp = 1e4;
      husk.speed = 0;
      husk.atkCd = 1e9;
      let tg = null, i = 0;
      for (; i < 60 * 7 && !tg; i++) {
        G.tick(1 / 60);
        tg = S.telegraphs.find((t) => t.storm && Math.hypot(t.x - mx, t.z - mz) < 0.01) || null; // 认准这一对柱子的预警（布局里别的雷枢也可能在附近起手）
        P.x = mx; P.z = mz; husk.x = mx + (f.bx - f.ax) * 0.2; husk.z = mz + (f.bz - f.az) * 0.2;
      }
      out.node = { warnAt: +(i / 60).toFixed(2), shape: tg && tg.shape, w: tg && tg.w, dur: tg && tg.dur };
      const life0 = P.life, hp0 = husk.hp;
      for (let k = 0; k < 70 && S.telegraphs.indexOf(tg) >= 0; k++) {
        G.tick(1 / 60);
        P.x = mx; P.z = mz; husk.x = mx + (f.bx - f.ax) * 0.2; husk.z = mz + (f.bz - f.az) * 0.2;
      }
      G.tick(1 / 60);
      out.node.playerHit = +(life0 - P.life).toFixed(1);
      out.node.huskHit = +(hp0 - husk.hp).toFixed(1);
      G.debug.god(true);
      // 首领门外重生：进场地叫醒首领，倒下后重生在门外 2 m
      G.clearEnemies();
      G.enterZone(zi, 0);
      const z2 = S.zone;
      T.tp(z2.arena.tp.x, z2.arena.tp.z);
      G.debug.step(0.6);
      out.awake = !!(S.boss && S.boss.awake);
      G.debug.god(false);
      P.iframe = 0;
      G.hurtPlayer(1e9, 'phys');
      G.debug.step(4.3);
      out.respawn = { dead: P.dead, door: +(Math.hypot(P.x - z2.bossPos.x, P.z - z2.bossPos.z) - z2.bossR).toFixed(3), walk: W.walkable(P.x, P.z, 0.5) };
      G.debug.god(true);
      G.debug.zoneSeed(null);
      G.debug.noEnc = false;
      G.enterZone(0, 0);
      return out;
    });
    assert(r.seeds === 20 && !r.bad.length, 'storm 有种子不合格：' + r.bad.slice(0, 4).join(' | '));
    const z = r.zone;
    assert(z.gen === 'custom' && z.n >= 80 && z.boss && z.bad === 0 && z.elites <= 6 && z.chests === 3, '进区刷怪不对：' + JSON.stringify(z));
    assert(Math.abs(z.doorGap - 2) < 0.01 && z.doorWalk && z.wallMat, '场地门 / 区域外的墙不对：' + JSON.stringify(z));
    assert(r.node.shape === 'rect' && r.node.w === 2 && Math.abs(r.node.dur - 0.9) < 1e-6 && r.node.warnAt <= 6.5, '雷枢应在 5 秒一轮里先放 2 m 宽、0.9 秒的长条预警：' + JSON.stringify(r.node));
    assert(r.node.playerHit > 0 && r.node.huskHit > 0, '雷枢落雷应同时打到玩家和小怪：' + JSON.stringify(r.node));
    assert(r.awake && !r.respawn.dead && Math.abs(r.respawn.door - 2) < 0.01 && r.respawn.walk, '倒在首领战里应重生在门外 2 m：' + JSON.stringify(r));
    return '怪 ' + z.n + ' 只，雷枢 ' + r.node.warnAt + ' 秒起手，玩家 -' + r.node.playerHit + ' / 游魂 -' + r.node.huskHit;
  });

  await step('区域 abyss 布局：20 个种子都通过校验 + 进区刷怪正常 + 首领门外重生；L 形深渊 7 个平台、4 座桥、3 个洞，怪物等级按路径比例；虚空不挡子弹；余烬口先预警再喷发，伤玩家也伤怪', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const W = G.world, S = G.state, P = G.player, out = { bad: [] };
      for (let s = 1; s <= 20; s++) {
        const g = W.genLayout('abyss', s * 7919);
        if (!g.ok) out.bad.push(g.seed + '：' + g.why.join('；'));
      }
      const zi = G.ZONES.findIndex((z) => z.id === 'abyss');
      G.debug.zoneSeed(4242);
      G.enterZone(zi, 0);
      G.debug.zoneSeed(null);
      const z = S.zone, L = G.debug.layout();
      const mobs = S.enemies.filter((e) => !e.isBoss);
      out.zone = {
        gen: L.gen, n: mobs.length, elites: mobs.filter((e) => e.elite).length, chests: z.chests.length,
        vents: z.feats.filter((f) => f.kind === 'vent').length, shot: z.map.sdShot !== z.map.sd,
        badPos: mobs.filter((e) => !W.walkable(e.x, e.z, 0) || Math.hypot(e.x - z.start.x, e.z - z.start.z) < 12).length,
        boss: !!S.boss && W.inArena(S.boss.x, S.boss.z), lane: [-5, -2, 1, 4, 7].every((x) => W.walkable(x, 0, 0.6)),
        door: +(Math.hypot(z.bossDoor.x - z.bossPos.x, z.bossDoor.z - z.bossPos.z) - z.bossR).toFixed(3),
      };
      // 加长后的布局（size-abyss）：关键路径 7 个平台、4 座桥（最后一座是场地的门）、3 个洞穴；房间等级按 W.terrain.lvFor 折算，首尾和改前一样（+0 → +2）
      const plats = z.rooms.filter((r) => r.kind === 'room' && r.path);
      out.zone.plats = plats.length;
      out.zone.bridges = z.rooms.filter((r) => (r.tags || []).indexOf('bridge') >= 0).length;
      out.zone.caves = z.rooms.filter((r) => r.kind === 'side').length;
      out.zone.lvBad = z.rooms.filter((r) => r.path && r.lv !== W.terrain.lvFor(r.order, plats.length)).map((r) => r.id + ':' + r.order + '=' + r.lv)
        .concat(z.rooms.filter((r) => !r.path && !(r.lv >= 0 && r.lv <= 2)).map((r) => r.id + ':' + r.lv));
      out.zone.lvEnds = [plats[0].lv, z.rooms[z.arena.room].lv];
      const br = z.feats.find((f) => f.kind === 'bridge'), a = br.pts[0], b = br.pts[br.pts.length - 1];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, l = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
      const vx = mx + nx * 5, vz = mz + nz * 5;
      out.void = { walk: W.walkable(vx, vz, 0), shot: W.shotFree(vx, vz, -0.4), mat: W.matAt(vx, vz) === W.MAT.VOID };
      // 首领门外重生：打首领时倒下 → 重生在门上（离场地边缘 2），可走
      G.debug.god(true);
      G.debug.tpBoss();
      let t = 0;
      while (!S.boss.awake && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      out.awake = S.boss.awake;
      G.debug.god(false);
      P.iframe = 0;
      G.hurtPlayer(1e9, 'phys', null);
      out.dead = P.dead;
      G.debug.step(4.5);
      out.respawn = { dead: P.dead, door: +(Math.hypot(P.x - z.bossPos.x, P.z - z.bossPos.z) - z.bossR).toFixed(3), walk: W.walkable(P.x, P.z, 0.5) };
      G.debug.god(true);
      // 余烬口：玩家和一只游魂站在口上，让它下一步就开始预警
      for (const e of S.enemies.slice()) if (!e.isBoss) G.killEnemy(e);
      G.debug.step(0.1);
      const v = z.abyssVents && z.abyssVents[0];
      out.hasVents = !!v;
      if (v) {
        T.tp(v.x + 0.3, v.z);
        const e = G.spawnMob('husk', v.x - 0.3, v.z, z.level, { awake: true });
        e.speed = 0;
        e.atkCd = 1e9;
        const hp0 = e.hp, n0 = S.telegraphs.length;
        G.debug.god(false);
        P.life = P.maxLife;
        P.iframe = 0;
        v.t = 6 - 1 / 120;
        G.tick(1 / 60);
        const tel = S.telegraphs.filter((q) => q.x === v.x && q.z === v.z);
        out.vent = { tel: S.telegraphs.length - n0, r: tel[0] && tel[0].r, dur: tel[0] && tel[0].dur, hp0, life0: P.life };
        for (let i = 0; i < 60; i++) G.tick(1 / 60);
        out.vent.hp = e.dead ? 0 : e.hp;
        out.vent.life = P.life;
        out.vent.left = S.telegraphs.filter((q) => q.x === v.x && q.z === v.z).length;
        G.debug.god(true);
        P.life = P.maxLife;
      }
      G.enterZone(0, 0);
      return out;
    });
    assert(!r.bad.length, 'abyss 有种子没通过校验：' + r.bad.slice(0, 3).join(' | '));
    const Z = r.zone;
    assert(Z.gen === 'custom' && Z.shot && Z.chests === 3 && Z.vents >= 4, 'abyss 应走自己的生成器、有虚空挖空、3 个宝箱、至少 4 个余烬口：' + JSON.stringify(Z));
    assert(Z.plats === 7 && Z.bridges === 4 && Z.caves === 3, 'abyss 加长后应有 7 个平台、4 座桥、3 个洞穴：' + JSON.stringify(Z));
    assert(!Z.lvBad.length && Z.lvEnds[0] === 0 && Z.lvEnds[1] === 2, '房间等级应按 lvFor(序号, 7) 折算、首尾 +0 / +2：' + JSON.stringify(Z));
    // zones-balance：每群人数 ×1.25，上下限跟着 ×1.25（56–112 → 70–140）
    assert(Z.n >= 70 && Z.n <= 140 && Z.elites >= 1 && Z.elites <= 6 && Z.badPos === 0 && Z.boss, '进区刷怪不对：' + JSON.stringify(Z));
    assert(Z.lane && Math.abs(Z.door - 2) < 0.01, '起点契约 / 首领门的位置不对：' + JSON.stringify(Z));
    assert(!r.void.walk && r.void.shot && r.void.mat, '虚空应不可走、子弹能飞过：' + JSON.stringify(r.void));
    assert(r.awake && r.dead && !r.respawn.dead && Math.abs(r.respawn.door - 2) < 0.01 && r.respawn.walk, '倒在首领战里应重生在门外：' + JSON.stringify(r));
    assert(r.hasVents && r.vent.tel === 1 && Math.abs(r.vent.r - 1.6) < 1e-6 && r.vent.dur > 0.5, '余烬口应先出一个预警圈：' + JSON.stringify(r.vent));
    assert(r.vent.left === 0 && r.vent.life < r.vent.life0 && r.vent.hp < r.vent.hp0, '余烬口喷发应伤到玩家和怪：' + JSON.stringify(r.vent));
    return '平台 ' + Z.plats + '，怪 ' + Z.n + '（精英 ' + Z.elites + '），余烬口 ' + Z.vents + '，喷发打掉玩家 ' + (r.vent.life0 - r.vent.life).toFixed(0) + '、游魂 ' + (r.vent.hp0 - r.vent.hp).toFixed(0);
  });

  await step('区域 rift 布局：20 个种子都通过校验 + 进区刷怪正常 + 首领门外重生（单向 C 形两圈、关键路径约 290 m、外圈内侧虚空挡人不挡子弹）', async () => {
    const r = await ev(() => {
      const W = G.world, bad = [], stats = [];
      const zi = G.ZONES.findIndex((z) => z.id === 'rift');
      for (let s = 1; s <= 20; s++) {
        const g = W.genLayout('rift', s * 7919);
        const sp = g.spec, pit = sp.feats.find((f) => f.kind === 'pit');
        const mobs = sp.packs.reduce((a, p) => a + (Array.isArray(p.n) ? (p.n[0] + p.n[1]) / 2 : p.n), 0);
        const elites = sp.packs.filter((p) => p.elite).length, sideElite = sp.packs.some((p) => p.elite && sp.rooms[p.room].kind === 'side');
        stats.push({ s, area: Math.round(g.area), len: pit ? Math.round(pit.len) : 0, mobs, elites, chests: sp.chests.length });
        if (!g.ok) bad.push(s + '：' + g.why.join('；'));
        // zones-polish：区域加长到 ×1.6：关键路径 170–195 → 270–305 m，每圈 3 个房间、旁支 3 个，怪 45–65 → 72–104，精英 ≤ 4 → ≤ 6，宝箱 2 → 3
        if (!pit || pit.len < 270 || pit.len > 305) bad.push(s + '：关键路径 ' + (pit && pit.len.toFixed(1)));
        if (sp.rooms.filter((q) => q.kind === 'room' && q.path).length !== 6 || sp.rooms.filter((q) => q.kind === 'side').length !== 3) bad.push(s + '：房间数不对');
        if (mobs < 72 || mobs > 104 || elites > 6 || !sideElite || sp.chests.length !== 3) bad.push(s + '：怪 / 精英 / 宝箱 ' + JSON.stringify(stats[stats.length - 1]));
      }
      // 进区：固定 3 个种子，看刷怪、首领、宝箱、虚空（挡人不挡子弹）、坑壁（都挡）
      const enter = [];
      for (const s of [7919, 15838, 23757]) {
        G.debug.zoneSeed(s);
        G.enterZone(zi, 0);
        const z = G.state.zone, L = W.layoutInfo(), pit = z.feats.find((f) => f.kind === 'pit'), boss = G.state.boss;
        const P = (ph, rr) => [pit.x + Math.sin(ph) * rr, pit.z + Math.cos(ph) * rr];
        // 横穿虚空：外圈上一点 → 正对着的坑心方向 10 m（落在虚空里）
        const vm = (pit.vA + pit.vB) / 2, a = P(vm, pit.rO), mid = P(vm, (pit.rV0 + pit.rV1) / 2), b = P(vm, pit.rV0 + 0.8);
        let shot = true;
        for (let k = 1; k < 20; k++) {
          const t = k / 20, x = a[0] + (b[0] - a[0]) * t, zz = a[1] + (b[1] - a[1]) * t;
          if (!W.shotFree(x, zz, -0.3)) shot = false;
        }
        // 中圈和坑底之间的坑壁：挡人也挡子弹
        const wa = P(pit.ph1 + (pit.ph2 - pit.ph1) * 0.4, (pit.rA + pit.rM - pit.hw) / 2);
        enter.push({
          s, gen: L.gen, n: G.state.enemies.length, elites: G.state.enemies.filter((e) => e.elite).length, chests: z.chests.length,
          bossIn: !!boss && W.inArena(boss.x, boss.z), voidWalk: W.walkable(mid[0], mid[1], 0), voidShot: shot, wallShot: W.shotFree(wa[0], wa[1], -0.3), wallWalk: W.walkable(wa[0], wa[1], 0),
          doorWalk: W.walkable(z.bossDoor.x, z.bossDoor.z, 0.5), ms: Math.round(z.ms.layout + z.ms.raster),
        });
      }
      // 首领门外重生：在场地里叫醒首领、打一下、倒下，重生点在场地门外（离场地边缘 2），首领复位
      const S = G.state, Pl = G.player;
      G.debug.god(true);
      G.debug.tpBoss();
      let t = 0;
      while (!S.boss.awake && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      const awake = S.boss.awake;
      G.hitEnemy(S.boss, G.skillCtx('basic_blade'), 1);
      G.debug.god(false);
      Pl.life = 1;
      let dt = 0;
      while (!Pl.dead && dt < 40) { G.tick(1 / 60); dt += 1 / 60; }
      const dead = Pl.dead;
      G.debug.step(Pl.deadT + 0.5);
      const z = S.zone, resp = {
        awake, dead, alive: !Pl.dead, door: +(Math.hypot(Pl.x - z.bossPos.x, Pl.z - z.bossPos.z) - z.bossR).toFixed(2), walk: W.walkable(Pl.x, Pl.z, 0.5),
        start: Math.hypot(Pl.x - z.start.x, Pl.z - z.start.z) > 30, bossHome: Math.hypot(S.boss.x - z.bossPos.x, S.boss.z - z.bossPos.z) < 0.01 && S.boss.hp === S.boss.maxHp && !S.boss.awake,
      };
      G.debug.god(true);
      G.debug.zoneSeed(null);
      G.enterZone(0, 0);
      return { bad, stats, enter, resp };
    });
    assert(!r.bad.length, 'rift 布局不合格：' + r.bad.slice(0, 5).join(' | '));
    for (const e of r.enter) {
      assert(e.gen === 'custom', 'rift 进区应走新生成器（不是 legacy）：' + JSON.stringify(e));
      assert(e.n >= 80 && e.n <= 140 && e.elites <= 6 && e.chests === 3, 'rift 刷怪 / 宝箱数量不对：' + JSON.stringify(e)); // zones-polish：40–70 → 64–112（×1.6），精英 ≤ 4 → ≤ 6，宝箱 2 → 3；zones-balance：每群 ×1.25，→ 80–140
      assert(e.bossIn && e.doorWalk, '首领应站在坑底场地里，门点 pad 0.5 可走：' + JSON.stringify(e));
      assert(!e.voidWalk && e.voidShot, '外圈内侧的虚空应挡人、不挡子弹：' + JSON.stringify(e));
      assert(!e.wallWalk && !e.wallShot, '中圈和坑底之间的坑壁应挡人也挡子弹：' + JSON.stringify(e));
    }
    assert(r.resp.awake && r.resp.dead && r.resp.alive, '首领战倒下、重生的流程不对：' + JSON.stringify(r.resp));
    assert(Math.abs(r.resp.door - 2) < 0.01 && r.resp.walk && r.resp.start, '倒在首领战里应重生在坑底场地的门外（离场地边缘 2）：' + JSON.stringify(r.resp));
    assert(r.resp.bossHome, '首领没有复位回满：' + JSON.stringify(r.resp));
    const avg = (k) => (r.stats.reduce((a, s) => a + s[k], 0) / r.stats.length).toFixed(0);
    return '20 个种子：面积 ' + avg('area') + ' m²、关键路径 ' + avg('len') + ' m、怪 ' + avg('mobs') + '；进区怪 ' + r.enter.map((e) => e.n + '（布局 + 光栅化 ' + e.ms + 'ms）').join(' / ');
  });

  await titleSteps();
}

// ------------------------------------------------------------------ 标题画面与暂停菜单（title-menu）
// 前面的步骤都跳过标题画面（harness 默认设 window.__skipTitle）。这里另开一个不跳过的浏览器，从空存档开始走一遍
async function titleSteps() {
  const titleState = () =>
    ev(() => {
      const vis = (sel) => {
        const n = document.querySelector(sel);
        return !!n && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0;
      };
      return {
        title: G.ui.titleOn(), open: G.ui.isOpen(), pause: G.ui.paused(), ready: document.getElementById('title').classList.contains('ready'),
        shown: vis('#title'), cont: vis('#t-continue'), save: document.getElementById('t-save').innerText, hud: vis('#hud'), intro: T.introOpen(),
        view: (document.querySelector('#title .m-view, #pause .m-view') || { dataset: {} }).dataset.view || null,
        has: G.hasSave(), stored: localStorage.getItem('cinder-abyss-save-v1'), time: G.state.time,
      };
    });
  const waitReady = () => until(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, 90000);
  // 回到标题画面：Esc 打开暂停菜单 → 返回主菜单
  const toTitle = async () => {
    await page.keyboard.press('Escape');
    assert(await ev(() => G.ui.paused()), 'Esc 没有打开暂停菜单');
    await page.click('#p-menu [data-tact="menu"]');
    assert(await ev(() => G.ui.titleOn()), '返回主菜单之后不在标题画面');
  };

  await step('标题画面：不跳过时载入先到标题画面（游戏暂停、HUD 隐藏）；没有存档时不显示「继续游戏」，也不写存档；设置 / 操作说明 / 致谢子页', async () => {
    if (browser) await browser.close().catch(() => {});
    ({ browser, page, errors } = await launch({ width: 1280, height: 720, title: true }));
    await install();
    await waitReady();
    await frames(3);
    let s = await titleState();
    assert(s.title && s.open && s.shown && !s.hud && !s.intro, '载入后应停在标题画面：' + JSON.stringify(s));
    assert(!s.cont && !s.has && s.stored === null, '没有存档时不该有「继续游戏」，也不该写存档：' + JSON.stringify({ cont: s.cont, has: s.has, stored: !!s.stored }));
    await frames(5);
    assert((await ev(() => G.state.time)) === s.time, '标题画面开着时模拟应暂停');
    const lay = await ev(() => ({ name: document.querySelector('.t-name').innerText, foot: document.querySelector('.t-foot').innerText, b: [...document.querySelectorAll('#t-menu .m-btn')].filter((n) => n.getClientRects().length).map((n) => T.rect(n)), w: innerWidth, h: innerHeight }));
    assert(lay.name === '烬渊' && lay.foot.includes('致谢') && lay.b.length === 3, '标题、致谢或按钮不对：' + JSON.stringify(lay));
    assert(lay.b.every((r) => r.l >= 0 && r.t >= 0 && r.r <= lay.w && r.b <= lay.h), '标题画面的按钮跑出了窗口：' + JSON.stringify(lay.b));
    // 子页：设置、操作说明、致谢；Esc 返回
    const sub = {};
    for (const [act, need] of [['settings', ['画质', '普通物品', '折叠普通物品的名牌']], ['help', ['翻滚', '武器普攻', 'Esc']], ['credits', ['Poly Haven', 'ambientCG', 'KayKit', 'Kenney', 'Quaternius', 'CC0']]]) {
      await page.click('#title [data-tact="' + act + '"]');
      const t = await ev(() => ({ view: document.querySelector('#title .m-view').dataset.view, txt: document.querySelector('#title .m-view').innerText, menu: getComputedStyle(document.getElementById('t-menu')).display, box: T.rect('#title .m-view'), w: innerWidth, h: innerHeight }));
      assert(t.view === act && t.menu === 'none' && need.every((w) => t.txt.includes(w)), act + ' 子页内容不对：' + JSON.stringify(t).slice(0, 300));
      assert(t.box.t >= 0 && t.box.b <= t.h && t.box.r <= t.w, act + ' 子页跑出了窗口：' + JSON.stringify(t.box));
      cleanText(t.txt, act + ' 子页');
      await page.keyboard.press('Escape');
      s = await titleState();
      assert(s.title && !s.view, 'Esc 应从子页返回标题菜单：' + JSON.stringify(s));
      sub[act] = t.txt.length;
    }
    assert((await titleState()).stored === null, '看了一圈子页还是不该写存档');
    return '子页字数 ' + JSON.stringify(sub);
  });

  await step('标题画面：新游戏（没有存档）直接开始、开场卡片随后弹出；没有面板时 Esc 打开暂停菜单，时间、冷却、无敌时间都停住，再按 Esc 继续', async () => {
    await page.click('#t-new');
    let s = await titleState();
    assert(!s.title && !s.shown && s.intro && s.hud && s.has, '新游戏后应进区并弹出开场卡片、写入存档：' + JSON.stringify(s));
    await page.keyboard.press('Enter');
    assert(!(await ev(() => G.ui.isOpen())), '回车应关闭开场卡片');
    await ev(() => { G.debug.god(true); G.debug.hold(false); }); // install() 停住了实时模拟（同第一步），这里要看真实的主循环
    await frames(3);
    const t1 = await ev(() => G.state.time);
    assert(t1 > s.time, '离开标题画面后模拟应恢复：' + t1 + ' / ' + s.time);
    const arm = () => ev(() => { const P = G.player; P.cds.ember = 2; P.roll.cd = 0.8; P.iframe = 1.5; return { t: G.state.time, cd: P.cds.ember, roll: P.roll.cd, ifr: P.iframe }; });
    const now = () => ev(() => { const P = G.player; return { t: G.state.time, cd: P.cds.ember, roll: P.roll.cd, ifr: P.iframe, paused: G.ui.paused(), open: G.ui.isOpen(), st: G.state.paused }; });
    await page.keyboard.press('Escape');
    const a = await arm();
    await frames(12);
    const b = await now();
    assert(b.paused && b.open && b.st, 'Esc（没有面板）应打开暂停菜单：' + JSON.stringify(b));
    assert(b.t === a.t && b.cd === a.cd && b.roll === a.roll && b.ifr === a.ifr, '暂停时时间 / 冷却 / 无敌时间不该走：' + JSON.stringify({ a, b }));
    const box = await ev(() => ({ r: T.rect('.pause-card'), txt: document.querySelector('.pause-card').innerText, w: innerWidth, h: innerHeight }));
    assert(['继续', '设置', '操作说明', '返回主菜单'].every((w) => box.txt.includes(w)), '暂停菜单的按钮不全：' + box.txt);
    assert(box.r.l >= 0 && box.r.t >= 0 && box.r.r <= box.w && box.r.b <= box.h, '暂停菜单跑出了窗口');
    await page.keyboard.press('Escape');
    await frames(12);
    const c = await now();
    assert(!c.paused && !c.open && c.t > b.t && c.roll < b.roll && c.ifr < b.ifr, '再按 Esc 应继续，时间和冷却接着走：' + JSON.stringify(c));
    // 「继续」按钮同样能关掉
    await page.keyboard.press('Escape');
    await page.click('#p-menu [data-tact="resume"]');
    assert(!(await ev(() => G.ui.isOpen())), '点「继续」应关闭暂停菜单');
    return '暂停 12 帧：时间 ' + a.t.toFixed(2) + ' → ' + b.t.toFixed(2) + '，继续后 ' + c.t.toFixed(2);
  });

  await step('暂停菜单：面板开着时 Esc 只关面板、不暂停；暂停菜单的子页里 Esc 返回上一层；暂停时按 I 打开背包', async () => {
    await page.keyboard.press('KeyI');
    assert((await ev(() => T.tab())) === 'inv', 'I 应打开背包');
    await page.keyboard.press('Escape');
    let r = await ev(() => ({ open: G.ui.isOpen(), pause: G.ui.paused(), tab: T.tab() }));
    assert(!r.open && !r.pause && r.tab === null, '面板开着时 Esc 应只关面板：' + JSON.stringify(r));
    await page.keyboard.press('Escape');
    await page.click('#p-menu [data-tact="settings"]');
    r = await ev(() => ({ pause: G.ui.paused(), view: (document.querySelector('#pause .m-view') || { dataset: {} }).dataset.view, menu: getComputedStyle(document.getElementById('p-menu')).display }));
    assert(r.pause && r.view === 'settings' && r.menu === 'none', '暂停菜单里应能打开设置：' + JSON.stringify(r));
    await page.keyboard.press('Escape');
    r = await ev(() => ({ pause: G.ui.paused(), view: !!document.querySelector('#pause .m-view'), menu: getComputedStyle(document.getElementById('p-menu')).display }));
    assert(r.pause && !r.view && r.menu !== 'none', '子页里 Esc 应回到暂停菜单：' + JSON.stringify(r));
    await page.click('#p-menu [data-tact="help"]');
    cleanText(await ev(() => document.querySelector('#pause .m-view').innerText), '暂停菜单的操作说明');
    await page.keyboard.press('Escape');
    await page.keyboard.press('KeyI');
    r = await ev(() => ({ pause: G.ui.paused(), tab: T.tab() }));
    assert(!r.pause && r.tab === 'inv', '暂停时按 I 应换成背包：' + JSON.stringify(r));
    await closePanel();
    assert(!(await ev(() => G.ui.paused())), '关掉背包后不该还在暂停');
  });

  await step('返回主菜单：先存档，再回到标题画面（继续游戏显示等级 / 武器 / 层级 / 区域）；继续回到原处，存档不变', async () => {
    const before = await ev(() => {
      G.debug.setLevel(7);
      G.debug.give('dust', 40);
      const P = G.player;
      T.tp(P.x + 1.5, P.z - 2);
      G.state.time += 0; // 不动
      return { canon: T.canon(G.save), x: P.x, z: P.z, zone: G.state.zone.def.name, idx: G.state.zoneIdx, w: G.save.equip.weapon ? G.save.equip.weapon.baseIdx : -1 };
    });
    await toTitle();
    await frames(5);
    let s = await titleState();
    const stored = await ev(() => T.canon(JSON.parse(localStorage.getItem('cinder-abyss-save-v1'))));
    assert(stored === before.canon, '返回主菜单前应先存档（localStorage 和内存不一致）');
    assert(s.title && s.shown && s.ready && s.cont && !s.hud, '应回到标题画面并显示「继续游戏」：' + JSON.stringify(s));
    const wname = await ev(() => document.querySelector('#t-save').innerText);
    assert(s.save.includes('7 级') && s.save.includes('初入') && s.save.includes(before.zone), '「继续游戏」的存档概要不对：' + s.save);
    assert(/刃|长杖|短杖|空手|武器/.test(wname), '存档概要里没有武器类型：' + wname);
    await frames(5);
    assert((await ev(() => G.state.time)) === s.time, '标题画面开着时模拟应暂停');
    await page.click('#t-continue');
    const after = await ev(() => ({ canon: T.canon(G.save), x: G.player.x, z: G.player.z, idx: G.state.zoneIdx, title: G.ui.titleOn(), open: G.ui.isOpen(), hud: getComputedStyle(document.getElementById('hud')).display }));
    assert(!after.title && !after.open && after.hud !== 'none', '继续之后应回到游戏：' + JSON.stringify(after));
    assert(after.canon === before.canon && after.idx === before.idx && Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.z - before.z) < 1e-6, '往返一趟后存档 / 位置变了');
    return s.save.replace(/\s+/g, ' ');
  });

  await step('有存档时载入：标题画面显示继续游戏（等级 / 武器 / 层级 / 区域），继续进入存档所在的区域，存档不变', async () => {
    const prep = await ev(() => {
      G.debug.setLevel(12);
      G.save.maxTier = Math.max(1, G.save.maxTier);
      G.save.cleared[G.ZONES[0].id] = 1; // 第二个区域在层级 1 解锁
      G.enterZone(1, 1);
      G.persist();
      return { canon: T.canon(G.save), zone: G.ZONES[1].name, lvl: G.state.zone.level };
    });
    await page.reload({ timeout: 90000 });
    await install();
    await waitReady();
    let s = await titleState();
    assert(s.title && s.cont && s.save.includes('12 级') && s.save.includes('轮回 1') && s.save.includes(prep.zone), '有存档时「继续游戏」的概要不对：' + JSON.stringify(s.save));
    await page.click('#t-continue');
    const r = await ev(() => ({ idx: G.state.zoneIdx, tier: G.state.tier, lvl: G.state.zone.level, canon: T.canon(G.save), title: G.ui.titleOn(), intro: T.introOpen(), lvlSave: G.save.level }));
    assert(!r.title && !r.intro && r.idx === 1 && r.tier === 1 && r.lvl === prep.lvl && r.lvlSave === 12, '继续应进入存档所在的区域（不再弹开场卡片）：' + JSON.stringify(r));
    assert(r.canon === prep.canon, '载入 → 标题画面 → 继续之后存档变了');
    return s.save.replace(/\s+/g, ' ');
  });

  await step('新游戏（有存档）先确认：取消保留存档，确认后从新角色开始（重载后跳过标题画面、弹出开场卡片）', async () => {
    await toTitle();
    const keep = await ev(() => localStorage.getItem('cinder-abyss-save-v1'));
    await page.click('#t-new');
    let s = await titleState();
    const txt = await ev(() => document.querySelector('#title .m-view').innerText);
    assert(s.title && s.view === 'confirm' && txt.includes('覆盖') && txt.includes('12 级'), '有存档时新游戏应先确认：' + JSON.stringify({ view: s.view, txt }));
    await page.click('#title [data-tact="back"]');
    s = await titleState();
    assert(s.title && !s.view && s.stored === keep && s.cont, '取消后应保留存档、回到标题菜单：' + JSON.stringify({ view: s.view, same: s.stored === keep }));
    await page.click('#t-new');
    await Promise.all([page.waitForEvent('load', { timeout: 90000 }), page.click('#title [data-tact="new-confirm"]')]);
    await install();
    await frames(2);
    const r = await ev(() => ({ title: G.ui.titleOn(), intro: T.introOpen(), lvl: G.save.level, zone: G.state.zone.def.id, tier: G.state.tier, maxTier: G.save.maxTier, once: sessionStorage.getItem('cinder-abyss-play-once'), stored: JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).level }));
    assert(!r.title && r.intro && r.lvl === 1 && r.zone === 'ash' && r.tier === 0 && r.maxTier === 0 && r.stored === 1, '确认后应是新角色、直接进区并弹开场卡片：' + JSON.stringify(r));
    assert(r.once === null, '一次性的跳过标记应已清掉');
    await page.keyboard.press('Enter');
  });

  await step('标题画面的设置：改画质、开关选项立即生效并存档，继续游戏、重新载入后仍是这一档', async () => {
    await toTitle();
    const q0 = await ev(() => G.world.quality());
    const q = q0 === 'mid' ? 'low' : 'mid';
    await page.click('#title [data-tact="settings"]');
    const h0 = await ev(() => G.save.opts.hideNormal);
    await page.click('#title [data-tact="quality"][data-q="' + q + '"]');
    await page.click('#title [data-tact="opt"][data-opt="hideNormal"]');
    let r = await ev(() => ({ live: G.world.quality(), opt: G.save.opts.quality, hide: G.save.opts.hideNormal, stored: JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).opts, on: document.querySelector('#title .seg-b.on[data-tact="quality"]').dataset.q }));
    assert(r.live === q && r.opt === q && r.stored.quality === q && r.on === q, '标题画面上改画质应立即生效并存档：' + JSON.stringify(r));
    assert(r.hide === !h0 && r.stored.hideNormal === !h0, '标题画面上的开关应存档：' + JSON.stringify(r));
    await page.keyboard.press('Escape');
    await page.click('#t-continue');
    await page.keyboard.press('KeyM');
    r = await ev(() => ({ live: G.world.quality(), on: (document.querySelector('#panel-body .seg-b.on[data-act="quality"]') || { dataset: {} }).dataset.q }));
    assert(r.live === q && r.on === q, '进游戏后画质应还是标题画面上选的那一档：' + JSON.stringify(r));
    await closePanel();
    await page.reload({ timeout: 90000 });
    await install();
    await waitReady();
    r = await ev(() => ({ live: G.world.quality(), opt: G.save.opts.quality, hide: G.save.opts.hideNormal }));
    assert(r.live === q && r.opt === q && r.hide === !h0, '重新载入后画质 / 开关应保持：' + JSON.stringify(r));
    return q0 + ' → ' + q;
  });

  await step('标题画面与暂停菜单在小窗口（1024×640）里放得下', async () => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await frames(2);
    const fit = (sel) => ev((sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length).map((n) => T.rect(n)).every((b) => b.l >= 0 && b.t >= 0 && b.r <= innerWidth && b.b <= innerHeight), sel);
    assert(await fit('.t-logo, #t-menu .m-btn, .t-foot'), '1024×640 下标题画面跑出了窗口');
    for (const act of ['settings', 'help', 'credits']) {
      await page.click('#title [data-tact="' + act + '"]');
      assert(await fit('#title .m-view, #title .m-head'), '1024×640 下 ' + act + ' 子页跑出了窗口');
      await page.keyboard.press('Escape');
    }
    await page.click('#t-continue');
    await page.keyboard.press('Escape');
    assert(await fit('.pause-card, #p-menu .m-btn'), '1024×640 下暂停菜单跑出了窗口');
    await page.click('#p-menu [data-tact="help"]');
    assert(await fit('.pause-card'), '1024×640 下暂停菜单的操作说明跑出了窗口');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert(!(await ev(() => G.ui.isOpen())), '收尾：暂停菜单没关掉');
  });
}

// 跑哪几份：默认两份都跑（先 func 后 timed，各用一个新浏览器）；--func / --timed 只跑一份。
// 只跑 func，或在 cc-slot 的池里跑（CC_SLOT_HELD=pool:…，或手动设 CC_POOL=1）时，每行的耗时和 ms 数字标成不可比
const PARTS = process.argv.includes('--func') ? ['func'] : process.argv.includes('--timed') ? ['timed'] : ['func', 'timed'];
const POOL = !!process.env.CC_POOL || /^pool:/.test(process.env.CC_SLOT_HELD || '');
const sum = (p, f) => (f ? '失败 ' + f + ' 项，' : '') + '通过 ' + p + ' 项';
(async () => {
  let head = '?';
  try {
    head = execSync('git rev-parse --short HEAD', { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {}
  const per = [];
  for (const part of PARTS) {
    NC_TAG = POOL || (part === 'func' && PARTS.length === 1) ? ' [pool, not comparable]' : '';
    cheap = part === 'func' && !process.env.CINDER_FULL;
    console.log('== test:' + part + ' · HEAD ' + head + ' · ' + new Date().toISOString() + ' · 槽位 ' + (process.env.CC_SLOT_HELD || '无') + (cheap ? ' · 省渲染 dpr ' + CHEAP_DPR + '（' + FULL_RES.length + ' 类步骤按 1）' : '') + (NC_TAG ? ' · 耗时数字不可比' + NC_TAG : '') + (part === 'timed' && POOL ? ' · 警告：计时步骤在池里跑，结果不作数' : ''));
    const p0 = passed, f0 = failed;
    try {
      await (part === 'func' ? main() : timedMain());
    } catch (e) {
      failed++;
      console.log('FAIL 测试脚本自身出错 — ' + (e && e.stack ? e.stack : e));
    }
    if (browser) await browser.close().catch(() => {});
    browser = page = errors = null;
    per.push('test:' + part + ' ' + sum(passed - p0, failed - f0));
  }
  console.log('\n' + per.join(' · '));
  console.log(sum(passed, failed));
  process.exit(failed ? 1 : 0);
})();
