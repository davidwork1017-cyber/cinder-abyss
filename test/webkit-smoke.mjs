// WebKit 冒烟（mobile M1）：用 Playwright 的 WebKit（iPhone 横屏模拟）把手机上的主流程走一遍。
// iPhone 上的 Chrome 底下也是 WebKit：这里能查出 JS / CSS / WebGL2 的兼容问题；iOS 特有的 GPU、系统行为查不出来。
// 需要 Playwright 的 WebKit 浏览器（npx playwright@<playwright-core 的版本> install webkit），所以不在 npm test 里：
//   npm run test:webkit（开发机上：cc-slot pool <名字> smoke -- npm run test:webkit）
// 流程：载入 → 标题画面 → 新游戏选职业 → 进区 → 开场卡片（只这一张教程）→ 摇杆移动 → 按住主攻施法 → 第一次松手解锁声音 → 0 页面报错
// 最后换一个新的浏览器配置量 iPhone 圆角：标题、职业选择、开场故事、HUD、背包、技能、暂停菜单、开场卡片的字和按钮都不碰四角的圆角（test/corner-mask.mjs）
import { webkit, devices } from 'playwright-core';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { GAME_URL, diagStep, outerTimeoutWarning } from './harness.mjs'; // 引入 harness 也就装上了它的信号处理：SIGTERM 时打 KILLED、立即退出
import { uiLayoutCheck, uiBlankPoint } from './ui-layout.mjs';
import { cornerScenes, cornerHud, cornerCheck } from './corner-mask.mjs';
import { STANDALONE_DEVICES, MOBILE_DEFAULT, standaloneContext, launch, questReady, lateGrow, converged } from './devices.mjs';
import { HUD_PARTS, PAINT_SRC, rotFrameProbe, rotFrameJudge, rotCanvasProbe, rotCanvasJudge } from './rot-standalone.mjs';

let passed = 0, failed = 0;
const lines = [];
function assert(c, m) {
  if (!c) throw new Error(m);
}
const dev = devices['iPhone 13 landscape'] || devices['iPhone 12 landscape'];
let head = '?';
try {
  head = execSync('git rev-parse --short HEAD', { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (e) {}
console.log('== test:webkit · HEAD ' + head + ' · ' + new Date().toISOString() + ' · ' + (dev ? 'iPhone 横屏 ' + dev.viewport.width + '×' + dev.viewport.height + ' DPR ' + dev.deviceScaleFactor : '?') + ' · 槽位 ' + (process.env.CC_SLOT_HELD || '无'));

const tw = outerTimeoutWarning(15); // 正常 5 分钟左右
if (tw) console.log(tw);
// 信号交给 harness（记一行再退出）；Playwright 自己接的话只关浏览器、进程照跑
const browser = await webkit.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
const ctx = await browser.newContext(Object.assign({}, dev));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url());
});
const ev = (fn, a) => page.evaluate(fn, a);
const until = (fn, a, t) => page.waitForFunction(fn, a, { timeout: t || 90000 });
const rect = (s) => ev((s) => {
  const n = document.querySelector(s);
  if (!n) return null;
  const b = n.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
}, s);
const tap = async (s) => {
  const r = await rect(s);
  assert(r && r.w > 0, '找不到可点的 ' + s);
  await page.touchscreen.tap(r.x, r.y);
};
// 合成触摸事件（Playwright 的 WebKit 只有 tap，没有按住 / 拖动）：从元素中心按下、可选地拖到 (dx, dy)
const touch = (type, s, dx, dy) =>
  ev(([type, s, dx, dy]) => {
    const n = document.querySelector(s);
    const b = n.getBoundingClientRect();
    const x = b.left + b.width / 2 + (dx || 0), y = b.top + b.height / 2 + (dy || 0);
    // 这个 WebKit 构建里 new Touch() 是非法构造：有 document.createTouch 就用它，否则发一个带 changedTouches 的普通事件（游戏只读这些字段）
    let t = null;
    try {
      t = new Touch({ identifier: 7, target: n, clientX: x, clientY: y, pageX: x, pageY: y });
    } catch (e) {
      try {
        if (document.createTouch) t = document.createTouch(window, n, 7, x, y, x, y);
      } catch (e2) {
        t = null;
      }
    }
    if (t && typeof TouchEvent === 'function') {
      try {
        const list = type === 'touchend' ? [] : [t];
        n.dispatchEvent(new TouchEvent(type, { touches: list, targetTouches: list, changedTouches: [t], bubbles: true, cancelable: true }));
        return 'TouchEvent';
      } catch (e) {
        /* 退回普通事件 */
      }
    }
    const pt = { identifier: 7, target: n, clientX: x, clientY: y, pageX: x, pageY: y };
    const evn = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(evn, 'changedTouches', { value: [pt] });
    Object.defineProperty(evn, 'touches', { value: type === 'touchend' ? [] : [pt] });
    n.dispatchEvent(evn);
    return 'Event';
  }, [type, s, dx, dy]);

// WEBKIT_ONLY=<名字里的一段>：只跑名字里有这段的步骤（自己开浏览器配置的那几步能单独跑，比如「可见区（rot-safe）」）
const ONLY = process.env.WEBKIT_ONLY || '';
async function step(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  diagStep('webkit：' + name);
  const t0 = Date.now();
  try {
    const info = await fn();
    await page.waitForTimeout(50);
    if (errors.length) throw new Error('页面报错：' + errors.splice(0).join(' | '));
    passed++;
    console.log('ok   ' + name + (info ? ' — ' + info : '') + '  (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ' — ' + String(e && e.message ? e.message : e).split('\n').slice(0, 4).join(' / ') + (errors.length ? ' ｜页面报错：' + errors.splice(0).join(' | ').slice(0, 500) : ''));
  }
}

let info = {};
await step('载入：标题画面出现，WebGL2 可用（或给出明确的提示），触屏模式自动打开', async () => {
  await page.goto(GAME_URL);
  await until(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, 120000);
  info = await ev(() => {
    const c = document.createElement('canvas');
    const gl2 = !!c.getContext('webgl2');
    return {
      ua: navigator.userAgent.slice(0, 60),
      gl2,
      lost: document.getElementById('ctx-lost') ? document.getElementById('ctx-lost').textContent : '',
      touch: G.touch.state(),
      coarse: matchMedia('(pointer: coarse)').matches,
      mtp: navigator.maxTouchPoints,
      q: G.world.quality(),
      dq: G.defaultQuality(),
      vv: window.visualViewport ? Math.round(visualViewport.width) + '×' + Math.round(visualViewport.height) : '无',
      appH: getComputedStyle(document.documentElement).getPropertyValue('--app-h'),
      manifest: !!document.querySelector('link[rel=manifest]'),
    };
  });
  assert(info.gl2 || /WebGL2/.test(info.lost), '没有 WebGL2 也没有提示：' + JSON.stringify(info));
  assert(info.gl2, '这个 WebKit 没有 WebGL2（页面给了提示：' + info.lost + '）');
  assert(info.touch.on, '触屏模式没有自动打开：' + JSON.stringify(info));
  return 'WebGL2 ' + info.gl2 + '，coarse ' + info.coarse + '，触点 ' + info.mtp + '，画质 ' + info.q + '（默认 ' + info.dq + '），可见 ' + info.vv + '，清单 ' + info.manifest;
});

await step('新游戏：选职业（点卡片、点确定），重载后进区；开场卡片「开始」点得到，之后不再接着弹「触屏操作」卡（只一张教程）', async () => {
  await tap('#t-new');
  await until(() => G.ui.classView && G.ui.classView());
  await tap('[data-tact="cl-sel"][data-cls]'); // B4b：窄屏的职业在一排标签里（.cl-tab）
  // 点「确定」会重载页面：先等着导航再点（只等 load 的话，旧页面本来就 load 完了，接下来的读取可能落在重载途中）
  const nav = page.waitForNavigation({ timeout: 120000 }).catch(() => {});
  await tap('[data-tact="cl-ok"]');
  await nav;
  await page.waitForLoadState('load').catch(() => {});
  await until(() => window.G && G.state && G.state.zone && G.player && G.player.ent, null, 120000);
  // 新角色先放开场故事：点「跳过」
  await page.waitForTimeout(1500);
  if (await ev(() => G.ui.storyOn())) await tap('.st-skip');
  await until(() => document.getElementById('intro').classList.contains('on'), null, 60000);
  // 开场卡片打开以后每帧看提示卡：一次都不该出现
  await ev(() => {
    window.__hint = 0;
    const f = () => {
      if (document.getElementById('t-hint').classList.contains('on')) window.__hint++;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const txt = await ev(() => document.querySelector('.intro-keys').innerText);
  assert(/拖动/.test(txt) && !/右键|左键|空格/.test(txt), '开场卡片应是触屏说法：' + txt);
  await tap('#intro-go');
  await page.waitForTimeout(2500);
  const s = await ev(() => ({ open: G.ui.isOpen(), st: G.touch.state(), hintFrames: window.__hint, key: localStorage.getItem('cinder-abyss-touch-hint'), cls: G.save.cls, zone: G.state.zone.def.name }));
  assert(!s.hintFrames && !s.st.hint && s.key === '1', '开场卡片之后不该再弹「触屏操作」卡：' + JSON.stringify(s));
  assert(!s.open && !s.st.blocked && s.cls, '应已进到游戏里：' + JSON.stringify(s));
  return s.cls + ' · ' + s.zone + ' · 教程 1 张';
});

await step('触屏：摇杆往右拖就往右走、松手停；第一次松手后 AudioContext 建好', async () => {
  const x0 = await ev(() => G.player.x);
  await touch('touchstart', '#t-stick', -40, 40);
  await touch('touchmove', '#t-stick', 10, 40);
  await page.waitForTimeout(1200);
  // M2：模拟摇杆写 input.move（单位向量 + 幅度），不再按 WASD
  const k = await ev(() => ({ mv: G.input.move && { x: G.input.move.x, z: G.input.move.z, k: G.input.move.k }, x: G.player.x }));
  await touch('touchend', '#t-stick', 10, 40);
  const a = await ev(() => {
    const c = G.audio.ctx();
    return { ctx: !!c, state: c ? c.state : null, keys: Object.keys(G.input.keys).filter((q) => G.input.keys[q]), mv: G.input.move };
  });
  assert(k.mv && k.mv.x > 0.99 && k.mv.k === 1 && k.x > x0 + 0.3, '摇杆没让玩家往右走：' + JSON.stringify({ x0, k }));
  assert(!a.keys.length && !a.mv, '松手后还有按着的键 / 移动向量：' + JSON.stringify(a));
  assert(a.ctx, '松手后应建好 AudioContext：' + JSON.stringify(a));
  return '走了 ' + (k.x - x0).toFixed(2) + ' m，声音 ' + a.state;
});

await step('触屏：按住主攻放出左键技能（每帧记下出手），点翻滚就滚', async () => {
  // 每帧看 P.cast：换了一个、而且是左键格的技能就算一次出手
  await ev(() => {
    window.__casts = 0;
    let last = G.player.cast;
    const f = () => {
      const c = G.player.cast;
      if (c && c !== last && c.id === G.save.bar[0]) window.__casts++;
      last = c;
      if (window.__casts >= 0) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await touch('touchstart', '[data-tb="s0"]');
  await page.waitForTimeout(2000);
  const m1 = await ev(() => ({ casts: window.__casts, id: G.save.bar[0], b: G.input.mouse.b[0], aim: !!G.input.aim }));
  await touch('touchend', '[data-tb="s0"]');
  await ev(() => (window.__casts = -1));
  assert(m1.b && m1.aim && m1.casts >= 1, '按住主攻应施法：' + JSON.stringify(m1));
  await ev(() => (G.player.roll.cd = 0));
  await touch('touchstart', '[data-tb="roll"]');
  const r = await ev(() => G.player.roll.t);
  await touch('touchend', '[data-tb="roll"]');
  assert(r > 0, '点翻滚应翻滚');
  return m1.id + ' 出手 ' + m1.casts + ' 次';
});

await step('面板布局（UI-R B1 + B4a）：844×340 / 390×844 下背包（空、筛选、说明、物品卡）、仓库（格子、物品卡）、属性（属性、图鉴）、地图（卡片、区域卡、说明）、帮助（操作、武器）、设置都过 a–f 检查（test/ui-layout.mjs），点卡片外面能收起', async () => {
  const fx = await ev(() => {
    G.debug.hold(true);
    const s = G.save;
    G.debug.setLevel(30);
    for (const id of G.CUR_IDS) s.cur[id] = 3;
    const slots = ['boots', 'belt', 'gloves', 'body', 'amulet', 'helm', 'ring'];
    for (let i = 0; i < 20; i++) G.debug.giveItem(i % 3, slots[i % slots.length], undefined, 28);
    const rare = G.debug.giveItem(2, 'ring', undefined, 28).uid;
    if (G.stash && G.stash.ok()) for (let i = G.stash.list().length; i < 10; i++) G.stash.put(G.rollItem(20, i % 3, slots[i % slots.length]), true);
    G.computeStats();
    return { rare: '.cell[data-item="' + rare + '"]' };
  });
  const vp0 = page.viewportSize();
  const bad = [];
  let n = 0;
  const settle = () => ev(async () => {
    for (const x of document.querySelectorAll('#panel-win, #panel-win *, #panel .sheet, #pause, #pause *')) for (const a of x.getAnimations()) await a.finished.catch(() => {});
  });
  for (const [w, h] of [[844, 340], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const states = [
      ['背包', ['inv'], []],
      ['筛选', ['inv'], ['[data-act="filter"]']],
      ['说明', ['inv'], [w <= 600 ? '#panel-body [data-act="hint"]' : '#panel-q']],
      ['物品卡', ['inv'], [fx.rare], true],
      ['仓库', ['stash'], []],
      ['仓库物品卡', ['stash'], ['.stp [data-grid="stash"] .cell[data-uid]'], true],
      ['属性', ['char', 'stats'], []],
      ['图鉴', ['char', 'stats'], ['[data-act="sub"][data-sub="codex"]']],
      // UI-R B4a：地图（区域卡片一排、区域卡、说明）、帮助（话题）、暂停菜单 → 设置
      ['地图', ['map'], []],
      ['区域卡', ['map'], ['.zone.zc[data-zone="1"]'], true],
      ['地图说明', ['map'], [w <= 600 ? '#panel-body [data-act="hint"]' : '#panel-q']],
      ['帮助', ['help', 'keys'], []],
      ['帮助·武器', ['help', 'keys'], ['[data-act="topic"][data-topic="weapon"]']],
      ['设置', ['pause'], ['#p-menu [data-tact="settings"]'], false, '#pause .pause-card'],
    ];
    for (const [id, open, taps, card, roots] of states) {
      n++;
      try {
        await ev(([t, sub]) => {
          G.ui.close();
          if (t === 'pause') G.ui.pause();
          else G.ui.open(t, sub);
        }, open);
        await page.waitForTimeout(150);
        for (const sel of taps) {
          await tap(sel);
          await page.waitForTimeout(200);
        }
        await settle();
        const r = await ev(uiLayoutCheck, roots ? { touch: true, max: 3, roots } : { touch: true, max: 3 });
        if (r.n) bad.push(w + '×' + h + ' ' + id + '：' + Object.entries(r.res).map(([k, v]) => k + ' ' + v.n + '（' + v.s.join('；') + '）').join(' '));
        if (card) {
          assert(await ev(() => !!document.querySelector('#panel .sheet')), id + ' 没有打开卡片');
          const p = await ev(uiBlankPoint);
          assert(p, id + ' 卡片外面找不到空白处');
          await page.touchscreen.tap(p.x, p.y);
          await page.waitForTimeout(200);
          if (await ev(() => !!document.querySelector('#panel .sheet'))) bad.push(w + '×' + h + ' ' + id + '：点卡片外面没有收起');
        }
      } catch (e) {
        bad.push(w + '×' + h + ' ' + id + '：' + String(e.message || e).slice(0, 200));
      }
    }
  }
  await ev(() => {
    G.ui.close();
    G.debug.hold(false); // 准备时按住了模拟（布局检查不用它跑）：还回去，后面的步骤要看游戏在跑
  });
  if (vp0) await page.setViewportSize(vp0);
  await page.waitForTimeout(300);
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return '2 个尺寸 × ' + n / 2 + ' 个状态 = ' + n + ' 次检查';
});

await step('面板布局（UI-R B2）：844×340 / 390×844 下技能页（列表、说明、技能卡、选辅助、武器技卡、辅助、辅助卡、学习）都过 a–f 检查，点卡片外面能收起', async () => {
  const k = await ev(() => {
    G.debug.hold(true);
    const s = G.save;
    G.debug.setLevel(30);
    G.debug.learnAll();
    for (const id of Object.keys(G.SUPPORTS).slice(0, 10)) if (!s.supports.includes(id)) s.supports.push(id);
    s.blankGems = [22];
    const sup = s.supports.find((x) => G.supportFits(s.bar[0], x));
    if (sup && !Object.values(s.sockets).some((a) => a && a.includes(sup))) G.socketSupport(s.bar[0], 0, sup);
    G.computeStats();
    return s.bar[0];
  });
  const vp0 = page.viewportSize();
  const bad = [];
  let n = 0;
  const settle = () => ev(async () => {
    for (const x of document.querySelectorAll('#panel-win, #panel-win *, #panel .sheet')) for (const a of x.getAnimations()) await a.finished.catch(() => {});
  });
  for (const [w, h] of [[844, 340], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const states = [
      ['列表', 'skills', []],
      ['说明', 'skills', [w <= 600 ? '#panel-body [data-act="hint"]' : '#panel-q']],
      ['技能卡', 'skills', ['.barstrip [data-act="sk-sel"][data-skill="' + k + '"]'], true], // 点技能栏那一格（列表里它那一行在 844×340 只露出一半，滚过去以后 uiBlankPoint 会把滚出去的行也当成点按目标）
      ['选辅助', k, ['.sheet .sock[data-skill="' + k + '"]:not(.full)'], true],
      ['武器技卡', 'skills', ['.sk-list [data-act="sk-sel"][data-skill="wskill"]'], true],
      ['辅助', 'sup', []],
      ['辅助卡', 'sup', ['.sup-row'], true],
      ['学习', 'learn', []],
    ];
    for (const [id, sub, taps, card] of states) {
      n++;
      try {
        await ev((sub) => { G.ui.close(); G.ui.open('skills', sub); }, sub);
        await page.waitForTimeout(150);
        for (const sel of taps) {
          await tap(sel);
          await page.waitForTimeout(200);
        }
        await settle();
        const r = await ev(uiLayoutCheck, { touch: true, max: 3 });
        if (r.n) bad.push(w + '×' + h + ' ' + id + '：' + Object.entries(r.res).map(([k, v]) => k + ' ' + v.n + '（' + v.s.join('；') + '）').join(' '));
        if (card) {
          assert(await ev(() => !!document.querySelector('#panel .sheet')), id + ' 没有打开卡片');
          const p = await ev(uiBlankPoint);
          assert(p, id + ' 卡片外面找不到空白处');
          await page.touchscreen.tap(p.x, p.y);
          await page.waitForTimeout(200);
          if (await ev(() => !!document.querySelector('#panel .sheet'))) bad.push(w + '×' + h + ' ' + id + '：点卡片外面没有收起');
        }
      } catch (e) {
        bad.push(w + '×' + h + ' ' + id + '：' + String(e.message || e).slice(0, 200));
      }
    }
  }
  await ev(() => {
    G.ui.close();
    G.debug.hold(false); // 还回去，后面的步骤要看游戏在跑
  });
  if (vp0) await page.setViewportSize(vp0);
  await page.waitForTimeout(300);
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return '2 个尺寸 × 8 个状态 = ' + n + ' 次检查';
});

await step('面板布局（UI-R B3）：844×340 / 390×844 下天赋页（全览、说明、汇总卡、节点卡、点亮后）都过 a–f 检查；点节点出节点卡、按「点亮」才点亮，点卡片外面能收起', async () => {
  await ev(() => {
    G.debug.hold(true);
    G.debug.setLevel(30);
    G.resetPassives();
    G.allocPassive('sm0');
    G.allocPassive('dm0');
    G.computeStats();
  });
  const vp0 = page.viewportSize();
  const bad = [];
  let n = 0;
  // 一直循环的动画（可点亮节点的光圈）不等
  const settle = () => ev(async () => {
    for (const x of document.querySelectorAll('#panel-win, #panel-win *, #panel .sheet')) for (const a of x.getAnimations()) if (a.effect && a.effect.getComputedTiming().iterations !== Infinity) await a.finished.catch(() => {});
  });
  const tapNode = async (id) => {
    const r = await ev((id) => { const b = document.querySelector('#tree-svg [data-node="' + id + '"] .shape').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, id);
    await page.touchscreen.tap(r.x, r.y);
  };
  for (const [w, h] of [[844, 340], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const states = [
      ['全览', []],
      ['说明', [w <= 600 ? '#panel-body [data-act="hint"]' : '#panel-q']],
      ['汇总卡', ['[data-act="tree-sum"]'], true],
      ['节点卡', ['node:dm1'], true],
      ['点亮后', ['node:dm1', '.sheet.tnode [data-act="node-go"]'], true],
    ];
    for (const [id, taps, card] of states) {
      n++;
      try {
        await ev(() => {
          G.ui.close();
          G.resetPassives();
          G.allocPassive('sm0');
          G.allocPassive('dm0');
          G.ui.open('tree');
          const f = document.querySelector('[data-act="tree-zoom"][data-z="fit"]');
          if (f && !f.classList.contains('on')) f.click();
        });
        await page.waitForTimeout(150);
        for (const sel of taps) {
          if (sel.startsWith('node:')) await tapNode(sel.slice(5));
          else await tap(sel);
          await page.waitForTimeout(200);
        }
        await settle();
        const r = await ev(uiLayoutCheck, { touch: true, max: 3 });
        if (r.n) bad.push(w + '×' + h + ' ' + id + '：' + Object.entries(r.res).map(([k, v]) => k + ' ' + v.n + '（' + v.s.join('；') + '）').join(' '));
        const lit = await ev(() => G.save.passives.includes('dm1'));
        if (id === '节点卡' && (lit || !(await ev(() => !!document.querySelector('.sheet.tnode'))))) bad.push(w + '×' + h + ' 节点卡：轻点应只出卡片、不点亮');
        if (id === '点亮后' && (!lit || !(await ev(() => !!document.querySelector('.sheet.tnode.lit'))))) bad.push(w + '×' + h + ' 点亮后：按「点亮」应点亮、卡片留着');
        if (card) {
          assert(await ev(() => !!document.querySelector('#panel .sheet')), id + ' 没有打开卡片');
          const p = await ev(uiBlankPoint);
          assert(p, id + ' 卡片外面找不到空白处');
          await page.touchscreen.tap(p.x, p.y);
          await page.waitForTimeout(200);
          if (await ev(() => !!document.querySelector('#panel .sheet'))) bad.push(w + '×' + h + ' ' + id + '：点卡片外面没有收起');
        }
      } catch (e) {
        bad.push(w + '×' + h + ' ' + id + '：' + String(e.message || e).slice(0, 200));
      }
    }
  }
  await ev(() => {
    G.ui.close();
    G.resetPassives();
    G.debug.hold(false); // 后面的步骤要看游戏在跑
  });
  if (vp0) await page.setViewportSize(vp0);
  await page.waitForTimeout(300);
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return '2 个尺寸 × 5 个状态 = ' + n + ' 次检查';
});

await step('面板布局（UI-R B4b）：844×340 / 390×844 下拾烬客（货架、卖出、烛芯、物品卡）和标题画面（主菜单、角色页、删除确认、职业选择）都过 a–f 检查，点卡片外面能收起', async () => {
  // 角色页要有几张卡：另外放 3 个角色和回收位一个（这一步收尾时删掉，后面的步骤看到的存档不变）
  const KEYS = ['cinder-abyss-save-v1-s4', 'cinder-abyss-save-v1-s5', 'cinder-abyss-save-v1-s6', 'cinder-abyss-trash'];
  const added = await ev((KEYS) => {
    G.debug.hold(true);
    window.__wkTier = G.state.tier || 0;
    window.__wkFrags = G.save.frags;
    G.state.tier = Math.max(G.state.tier || 0, G.TRADER.fragTier);
    G.save.frags = { seal: 3, rift: 1, vow: 2, box: 0 };
    const mk = (cls, lvl) => {
      const x = G.newClassSave(cls);
      x.level = lvl;
      x.seenHelp = x.seenStory = true;
      return JSON.stringify(x);
    };
    const out = [];
    const vals = [mk('hunt', 12), mk('lamp', 41), mk('forge', 7), JSON.stringify({ v: 1, slot: 5, t: Date.now() - 3600e3, played: 0, text: mk('guard', 19) })];
    KEYS.forEach((k, i) => {
      if (localStorage.getItem(k) === null) {
        localStorage.setItem(k, vals[i]);
        out.push(k);
      }
    });
    if (!(G.state.trader && G.state.trader.stock)) G.traderOpen({ level: 28 });
    G.ui.close();
    return out;
  }, KEYS);
  const vp0 = page.viewportSize();
  const bad = [];
  let n = 0;
  const settle = () => ev(async () => {
    for (const x of document.querySelectorAll('#panel-win, #panel-win *, #panel .sheet, #title .m-view')) for (const a of x.getAnimations()) await a.finished.catch(() => {});
  });
  const TITLE = { roots: '#title .t-main, #title .t-foot, #t-rot-go, #t-rot-flip', head: '#title .m-head' };
  for (const [w, h] of [[844, 340], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const states = [
      ['货架', 'trader', []],
      ['卖出', 'trader', ['[data-act="trd-view"][data-v="sell"]']],
      ['烛芯', 'trader', ['[data-act="trd-view"][data-v="frag"]']],
      ['货架物品卡', 'trader', ['.trd-row[data-act="trd-card"]'], true],
      ['标题', 'title', []],
      ['角色页', 'title', ['#t-chars']],
      ['删除确认', 'title', ['#t-chars', '[data-tact="ch-del"]']],
      ['选职业', 'title', ['#t-new']],
    ];
    for (const [id, where, taps, card] of states) {
      n++;
      try {
        await ev((where) => {
          if (G.ui.titleOn()) G.ui.hideTitle();
          G.ui.close();
          if (where === 'title') G.ui.showTitle(true);
          else G.ui.open('trader');
        }, where);
        await page.waitForTimeout(200);
        for (const sel of taps) {
          await tap(sel);
          await page.waitForTimeout(250);
        }
        await settle();
        const r = await ev(uiLayoutCheck, Object.assign({ touch: true, max: 3 }, where === 'title' ? TITLE : {}));
        if (r.n) bad.push(w + '×' + h + ' ' + id + '：' + Object.entries(r.res).map(([k, v]) => k + ' ' + v.n + '（' + v.s.join('；') + '）').join(' '));
        if (card) {
          assert(await ev(() => !!document.querySelector('#panel .sheet')), id + ' 没有打开卡片');
          const p = await ev(uiBlankPoint);
          assert(p, id + ' 卡片外面找不到空白处');
          await page.touchscreen.tap(p.x, p.y);
          await page.waitForTimeout(200);
          if (await ev(() => !!document.querySelector('#panel .sheet'))) bad.push(w + '×' + h + ' ' + id + '：点卡片外面没有收起');
        }
      } catch (e) {
        bad.push(w + '×' + h + ' ' + id + '：' + String(e.message || e).slice(0, 200));
      }
    }
  }
  await ev((added) => {
    if (G.ui.titleOn()) G.ui.hideTitle();
    G.ui.close();
    for (const k of added) localStorage.removeItem(k);
    G.state.tier = window.__wkTier;
    G.save.frags = window.__wkFrags;
    G.debug.hold(false);
  }, added);
  if (vp0) await page.setViewportSize(vp0);
  await page.waitForTimeout(300);
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return '2 个尺寸 × 8 个状态 = ' + n + ' 次检查';
});

await step('画面：渲染在跑（时间在走、没有丢失上下文），纹理内存', async () => {
  const t0 = await ev(() => G.state.time);
  await page.waitForTimeout(1500);
  const g = await ev(() => {
    // 场景材质上的纹理总量（粗估：宽 × 高 × 4 字节，带 mipmap 再 × 4/3；压缩纹理按数据大小）
    const R = G.world.renderer, seen = new Set();
    let bytes = 0;
    const add = (t) => {
      if (!t || !t.isTexture || seen.has(t)) return;
      seen.add(t);
      if (t.isCompressedTexture && t.mipmaps && t.mipmaps.length) {
        for (const m of t.mipmaps) bytes += (m.data && m.data.byteLength) || 0;
        return;
      }
      const im = t.image || {};
      bytes += (im.width || 0) * (im.height || 0) * (im.depth || 1) * 4 * (t.generateMipmaps !== false ? 4 / 3 : 1);
    };
    G.world.scene.traverse((o) => {
      for (const mt of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) for (const k in mt) if (mt[k] && mt[k].isTexture) add(mt[k]);
    });
    const info = G.world.gfxInfo ? G.world.gfxInfo() : {};
    return { t: G.state.time, lost: !!(G.ctxLost && G.ctxLost()), quality: info.quality, post: info.post, dpr: info.dpr, scale: info.scale, tex: R.info.memory.textures, texMB: +(bytes / 1048576).toFixed(1), draws: R.info.render.calls };
  });
  assert(g.t > t0 && !g.lost, '游戏没在跑：' + JSON.stringify({ t0, g }));
  if (process.env.WEBKIT_SHOT) await page.screenshot({ path: process.env.WEBKIT_SHOT });
  return '画质 ' + g.quality + '（后期 ' + g.post + '，DPR ' + g.dpr + ' × ' + g.scale + '），GPU 纹理 ' + g.tex + ' 张、场景材质约 ' + g.texMB + ' MB，draws ' + g.draws;
});

// mem-hunt：内存。WebKit 的垃圾回收很懒，不先回收的话每次换区的垃圾（旧区的几何体数组等）堆着，看起来像在涨；量之前先 page.requestGC()（WebKit 的 Heap.gc）。
// 这台机器上 WebKit 用 Mesa llvmpipe 软件渲染，显存那份也算在 WebProcess 里（iPhone 上在 GPU 进程），所以第一圈涨一截是正常的（缓存、分配器的高水位）；
// 之后就该平了。回收以后每圈末的 RSS 还会上下跳 ±200 MB（软件 GL 和 glibc 什么时候把内存还给系统说不准，不是单调的），所以不拿第二圈比第一圈，
// 走三圈、拿第三圈比前两圈里高的那一圈（高水位）：真在漏的话每圈都把高水位往上推。实测第三圈 − max(第一、二圈) = −10…−107 MB，没释放整区的东西时一圈要多出好几百 MB
const RSS_LAP2_MB = 100;
function webProcRssMB() {
  // 这个 node 进程底下最大的 WebKit 进程（WPEWebProcess / WebKitWebProcess）的 RSS；不是 Linux 就返回 null
  try {
    const kids = {};
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = readFileSync('/proc/' + d + '/stat', 'utf8');
        const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
        (kids[pp] || (kids[pp] = [])).push(+d);
      } catch (e) {}
    }
    let best = null;
    const stack = [process.pid];
    while (stack.length) {
      for (const k of kids[stack.pop()] || []) {
        stack.push(k);
        try {
          const cmd = readFileSync('/proc/' + k + '/cmdline', 'utf8');
          if (!/WebProcess/.test(cmd)) continue;
          const rss = +(readFileSync('/proc/' + k + '/status', 'utf8').match(/^VmRSS:\s+(\d+)/m) || [0, 0])[1] / 1024;
          if (!best || rss > best) best = rss;
        } catch (e) {}
      }
    }
    return best ? +best.toFixed(1) : null;
  } catch (e) {
    return null;
  }
}
// 换区卡顿（mem-hunt）：一次贴图上传（texImage2D / texSubImage2D）超过 100 ms 就算卡。这里软件渲染一帧本来就 0.5–1 秒，没法按「长任务」判断，只量上传；
// 原来每次进烬渊，深渊底那张画布贴图一次传 0.8–0.9 秒（WebKit 的画布 → GL 拷贝），现在传像素
const UPLOAD_MAX_MS = 100;
await step('内存：低档连走五个区三圈（每区打首领、清怪），回收后第三圈 WebProcess 的 RSS 不比前两圈高 ' + RSS_LAP2_MB + ' MB 以上，几何体 / 贴图 / 程序回到第一圈的水平；第二、三圈再进区没有一次贴图上传超过 ' + UPLOAD_MAX_MS + ' ms，烬渊深渊底的贴图传像素、和传画布逐像素相同', async () => {
  const st0 = await ev(() => ({ zi: G.state.zoneIdx, tier: G.state.tier, q: G.world.quality(), god: !!G.player.god }));
  const laps = [];
  let deep = null;
  try {
    await ev(() => {
      G.debug.hold(true);
      G.debug.god(true);
      G.world.setQuality('low');
      // 记下每次贴图上传的耗时（只包一层原型方法，测完换回去）
      const P = WebGL2RenderingContext.prototype, U = (window.__upl = { max: 0, at: '', orig: {} });
      for (const k of ['texImage2D', 'texSubImage2D']) {
        const f = (U.orig[k] = P[k]);
        P[k] = function () {
          const t = performance.now();
          try {
            return f.apply(this, arguments);
          } finally {
            const ms = performance.now() - t, src = arguments[arguments.length - 1];
            if (ms > U.max) (U.max = ms), (U.at = (G.state.zone ? G.state.zone.def.id : '?') + ' ' + (src && src.constructor ? src.constructor.name : typeof src) + ' ' + (src && src.width) + '×' + (src && src.height));
          }
        };
      }
    });
    for (let lap = 0; lap < 3; lap++) {
      await ev(() => {
        __upl.max = 0;
        __upl.at = '';
      });
      for (const zi of [0, 1, 2, 3, 4, 0]) {
        await ev((zi) => G.enterZone(zi, 0), zi);
        await until(() => !G.world.assetsPending() && G.world.gfxInfo().hd, null, 60000);
        if (zi === 3 && !deep) deep = await ev(() => G.world.abyssDeepProbe());
        await ev(() => {
          const S = G.state;
          G.debug.step(0.1);
          G.debug.tpBoss();
          const b = S.enemies.find((e) => e.isBoss && !e.dead);
          G.input.aim = b ? { x: b.x, z: b.z } : null;
          G.input.mouse.b[0] = true;
          G.debug.step(2);
          G.debug.killAll();
          const b2 = S.enemies.find((e) => e.isBoss && !e.dead);
          if (b2) G.killEnemy(b2);
          G.input.mouse.b[0] = false;
          G.input.aim = null;
          G.debug.step(2);
          G.world.render();
        });
      }
      await page.waitForTimeout(500);
      await page.requestGC();
      await page.waitForTimeout(300);
      await page.requestGC();
      await page.waitForTimeout(500);
      const m = await ev(() => {
        const R = G.world.renderer;
        return { geo: R.info.memory.geometries, tex: R.info.memory.textures, prog: R.info.programs.length, upMs: Math.round(__upl.max), upAt: __upl.at };
      });
      m.rss = webProcRssMB();
      laps.push(m);
    }
  } finally {
    await ev((s) => {
      if (window.__upl) for (const k in __upl.orig) WebGL2RenderingContext.prototype[k] = __upl.orig[k];
      G.world.setQuality(s.q);
      G.enterZone(s.zi, s.tier);
      G.debug.god(s.god);
      G.debug.hold(false);
    }, st0);
    await until(() => !G.world.assetsPending(), null, 60000).catch(() => {});
  }
  const [l1, l2, l3] = laps;
  // 贴图留 6 张余量：有些全局贴图第一次用到才建、建了就一直留着（异兆道具的环 / 符文这类随机出现的东西可能第二圈才第一次碰到）；漏掉整区的贴图一圈是几十张
  for (const l of [l2, l3]) assert(l.geo - l1.geo <= 3 && l.tex - l1.tex <= 6 && l.prog - l1.prog <= 3, '后两圈没回到第一圈的水平：' + JSON.stringify(laps));
  for (const l of [l2, l3]) assert(l.upMs <= UPLOAD_MAX_MS, '再进区有一次贴图上传 ' + l.upMs + ' ms（' + l.upAt + '）');
  assert(deep && deep.via === 'data' && deep.data === deep.canvas, '烬渊深渊底的贴图应传像素、和传画布逐像素相同：' + JSON.stringify(deep));
  const hw = l1.rss != null && l2.rss != null && l3.rss != null ? l3.rss - Math.max(l1.rss, l2.rss) : null;
  if (hw != null) assert(hw <= RSS_LAP2_MB, '回收后第三圈 WebProcess 比前两圈的高水位还高 ' + hw.toFixed(0) + ' MB：' + JSON.stringify(laps));
  const rss = hw != null ? 'WebProcess 每圈末 ' + l1.rss.toFixed(0) + ' / ' + l2.rss.toFixed(0) + ' / ' + l3.rss.toFixed(0) + ' MB（第三圈 − 高水位 ' + (hw >= 0 ? '+' : '') + hw.toFixed(0) + '）' : 'RSS 量不到（不是 Linux）';
  return rss + ' ｜ 几何体 ' + l1.geo + ' → ' + l2.geo + ' → ' + l3.geo + '，贴图 ' + l1.tex + ' → ' + l2.tex + ' → ' + l3.tex + '，程序 ' + l1.prog + ' → ' + l2.prog + ' → ' + l3.prog + ' ｜ 最长一次贴图上传 第一圈 ' + l1.upMs + ' ms（' + l1.upAt + '）/ 第二、三圈 ' + Math.max(l2.upMs, l3.upMs) + ' ms ｜ 深渊底传像素 ' + deep.dataMs + ' ms / 传画布 ' + deep.canvasMs + ' ms';
});

await step('M2：iPhone 没有震动接口，设置里不显示「震动」；长按地图上的区域卡片出详情，松手留着', async () => {
  const r = await ev(() => ({ vib: typeof navigator.vibrate, can: G.touch.canVibe() }));
  await ev(() => G.ui.pause());
  await tap('#p-menu [data-tact="settings"]');
  await page.waitForTimeout(300);
  const rows = await ev(() => Array.from(document.querySelectorAll('#p-view .m-row .opt-text b')).map((b) => b.textContent));
  await ev(() => {
    G.ui.close();
    G.ui.open('map');
  });
  await page.waitForTimeout(500);
  await touch('touchstart', '.zone[data-tip="zone:1:0"]');
  // 按住到长按触发（机器忙时 WebKit 一帧几百毫秒，计时器会晚到）再松手
  await until(() => G.touch.state().lp === 'on', null, 5000).catch(() => {});
  await page.waitForTimeout(150);
  const a = await ev(() => ({ tip: getComputedStyle(document.getElementById('tip')).display !== 'none' && document.getElementById('tip').textContent.length > 0, lp: G.touch.state().lp }));
  await touch('touchend', '.zone[data-tip="zone:1:0"]');
  await page.waitForTimeout(300);
  const b = await ev(() => ({ tip: getComputedStyle(document.getElementById('tip')).display !== 'none', lp: G.touch.state().lp }));
  await ev(() => G.ui.close());
  assert(!r.can && !rows.includes('震动') && rows.includes('按钮大小') && rows.includes('左手模式'), '没有震动接口时不该显示震动：' + JSON.stringify({ r, rows }));
  assert(a.tip && a.lp === 'on' && b.tip && b.lp === 'stuck', '长按区域卡片应出详情、松手留着：' + JSON.stringify({ a, b }));
  return 'vibrate ' + r.vib + '，设置 ' + rows.length + ' 项（无震动）；长按详情留着';
});

// ---------- 竖着拿 iPhone：「横屏开始」→ 旋转横屏（iPhone 没有 screen.orientation.lock），在转过的画面里新游戏、走、打、开背包 ----------
await step('竖屏（iPhone 竖着拿）：标题画面点「横屏开始」→ 画面转 90°；转着新建角色（选职业、重载后接着转）、摇杆往画面右边走、按住主攻放技能、顶栏开背包', async () => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.reload();
  await until(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, 120000);
  await page.waitForTimeout(300);
  const t0 = await ev(() => ({ st: G.touch.state(), go: getComputedStyle(document.getElementById('t-rot-go')).display, lock: !!(screen.orientation && screen.orientation.lock), fs: !!document.documentElement.requestFullscreen }));
  assert(t0.st.portrait && t0.go !== 'none', '竖着时标题画面应有「横屏开始」：' + JSON.stringify(t0));
  await tap('#t-rot-go');
  await until(() => G.touch.state().rot, null, 10000);
  await page.waitForTimeout(400);
  const t1 = await ev(() => ({ st: G.touch.state(), cls: document.documentElement.className, vw: G.viewW(), vh: G.viewH(), body: document.body.style.transform, try: G.touch.rotTry }));
  assert(t1.st.rot && /t-rot/.test(t1.cls) && t1.vw === 664 && t1.vh === 390 && /rotate/.test(t1.body), '应转成 664×390 的横屏画面：' + JSON.stringify(t1));
  // 转着新建角色：选职业要重载页面，重载后（手机还竖着）接着转
  await tap('#t-new');
  await until(() => G.ui.classView && G.ui.classView());
  await tap('[data-tact="cl-sel"][data-cls]'); // B4b：窄屏的职业在一排标签里（.cl-tab）
  // 点「确定」会重载页面：先等着导航再点（只等 load 的话，旧页面本来就 load 完了，接下来的读取可能落在重载途中）
  const nav = page.waitForNavigation({ timeout: 120000 }).catch(() => {});
  await tap('[data-tact="cl-ok"]');
  await nav;
  await page.waitForLoadState('load').catch(() => {});
  await until(() => window.G && G.state && G.state.zone && G.player && G.player.ent && G.touch, null, 120000);
  // 新角色先放开场故事：「跳过」淡入以后点掉，直到开场卡片出来（机器忙时故事、卡片都晚一点）
  let q = null;
  for (const t0 = Date.now(); Date.now() - t0 < 90000; ) {
    q = await ev(() => {
      const n = document.querySelector('.st-skip');
      return { story: G.ui.storyOn(), ended: !!(G.story && G.story.info && G.story.info().ended), intro: document.getElementById('intro').classList.contains('on'), skip: !!(n && n.getBoundingClientRect().width > 0), title: G.ui.titleOn(), open: G.ui.isOpen(), rot: G.touch.state().rot, cls: document.documentElement.className, view: G.ui.classView && G.ui.classView(), url: location.search };
    });
    if (q.intro) break;
    // 已经在收尾淡出的故事不再点「跳过」：那时模拟已经接着跑了，淡出中的故事层不接点按，这一下会落到下面 HUD 的主攻键上，
    // 记进缓冲、起手一次（下面量摇杆位移时撞上过这一刀）
    if (q.story && q.skip && !q.ended) await tap('.st-skip').catch(() => {});
    // 开场故事和开场卡片所有角色共用：前面那一步看过了，第二个角色就直接进游戏
    if (!q.story && !q.title && !q.open && (await ev(() => G.save.seenHelp && G.save.seenStory))) break;
    await page.waitForTimeout(700);
  }
  assert(q && (q.intro || (!q.story && !q.open)), '应进到游戏或开场卡片：' + JSON.stringify(q));
  const rot2 = await ev(() => G.touch.state().rot);
  // B4b：关开场卡片 / 提示卡的这一下不能漏进游戏（不出手、没有按着的按钮、没有缓冲的轻点）：关之前开始每帧记
  await ev(() => {
    window.__tt = [];
    window.__ttOff = false;
    const P = G.player, I = G.input;
    const f = () => {
      const held = G.touch.state().held.length;
      if (P.cast || held || I.mouse.b.some(Boolean) || (I.tap && I.tap.some((v) => v > 0))) window.__tt.push({ cast: P.cast ? P.cast.id : null, held, b: I.mouse.b.map(Number).join('') });
      if (!window.__ttOff) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  if (q.intro) await tap('#intro-go');
  await page.waitForTimeout(600);
  if (await ev(() => G.touch.state().hint)) await tap('#t-hint-ok');
  await page.waitForTimeout(300);
  const leak = await ev(() => {
    window.__ttOff = true;
    return window.__tt.splice(0);
  });
  assert(!leak.length, '关开场卡片 / 提示卡的这一下漏进了游戏：' + JSON.stringify(leak.slice(0, 4)));
  const g0 = await ev(() => ({ st: G.touch.state(), open: G.ui.isOpen(), x: G.player.x }));
  assert(rot2 && g0.st.rot === rot2 && !g0.open && !g0.st.blocked, '重载后应接着转、进到游戏里：' + JSON.stringify({ rot2, g0 }));
  // 摇杆：画面里往右 = 屏幕上往下（顺时针）/ 往上（逆时针）
  const sy = g0.st.rot === 'cw' ? 1 : -1;
  // 位移全按模拟时间量，起点固定：先停住实时模拟（hold 同时清掉残留的输入），手上还有没做完的动作（出手 / 翻滚 / 处决）就不带输入推进到做完（最多 2 秒），
  // 再按住摇杆、推进 0.3 秒。以前按住后先按墙钟等 300 ms，期间实时循环跑几帧算几帧（机器忙时只有一两帧），量的时候处在什么状态不确定：
  // 一次 ui-b4b 的运行在 0.3 秒里只走了 1.152 m（满速 2.16 m）
  const pre = await ev(() => {
    const P = G.player;
    G.debug.hold(true);
    const busy = () => !!(P.cast || P.roll.t > 0 || P.exec);
    const was = { cast: P.cast ? P.cast.id + '@' + (P.cast.t || 0).toFixed(2) : '', roll: +P.roll.t.toFixed(2), exec: !!P.exec, t: +G.state.time.toFixed(2) };
    let n = 0;
    while (busy() && n < 120) {
      G.debug.step(1 / 60);
      n++;
    }
    return { was, settle: n, busy: busy() };
  });
  assert(!pre.busy, '停住模拟后手上的动作 2 秒内应做完：' + JSON.stringify(pre));
  await touch('touchstart', '#t-stick', 0, 0);
  await touch('touchmove', '#t-stick', 0, 50 * sy);
  const m = await ev(() => {
    const P = G.player, inp = G.input, x0 = P.x, z0 = P.z;
    const mv = inp.move && { x: inp.move.x, z: inp.move.z, k: inp.move.k };
    const fr = [];
    for (let i = 0; i < 18; i++) {
      const xa = P.x;
      G.debug.step(1 / 60);
      fr.push(+(P.x - xa).toFixed(3) + (P.cast ? '*' + P.cast.id : '') + (P.roll.t > 0 ? 'R' : ''));
    }
    return { mv, x: P.x, dx: P.x - x0, dz: P.z - z0, sp: P.moveSpeed, fr };
  });
  await touch('touchend', '#t-stick', 0, 50 * sy);
  await ev(() => G.debug.hold(false));
  // 满速 0.3 秒走 0.3 × moveSpeed，至少要七成；方向是画面右边（+x），侧向偏不到前进的一成
  assert(m.mv && m.mv.x > 0.95 && m.mv.k === 1 && m.dx > 0.3 * m.sp * 0.7 && Math.abs(m.dz) < 0.1 * m.dx, '转着时摇杆往画面右边拖应往右走：' + JSON.stringify({ g0, pre, m }));
  // 按住主攻
  await ev(() => {
    window.__casts = 0;
    let last = G.player.cast;
    const f = () => {
      const c = G.player.cast;
      if (c && c !== last && c.id === G.save.bar[0]) window.__casts++;
      last = c;
      if (window.__casts >= 0) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await touch('touchstart', '[data-tb="s0"]');
  await page.waitForTimeout(1200);
  const c = await ev(() => ({ b: G.input.mouse.b[0], casts: window.__casts }));
  await touch('touchend', '[data-tb="s0"]');
  await ev(() => (window.__casts = -1));
  assert(c.b && c.casts >= 1, '转着时按住主攻应施法：' + JSON.stringify(c));
  // 顶栏「包」：背包铺满转过的画面
  await tap('[data-tt="inv"]');
  await page.waitForTimeout(500);
  const pw = await ev(async () => {
    const n = document.getElementById('panel-win');
    for (let el = n; el; el = el.parentElement) if (el.getAnimations) await Promise.all(el.getAnimations().map((x) => x.finished.catch(() => {}))); // 入场动画（往上 8 px、0.99 倍）放完再量
    return { open: G.ui.isOpen(), r: G.rectToFrame(n.getBoundingClientRect()) };
  });
  await ev(() => G.ui.close());
  assert(pw.open && Math.abs(pw.r.width - 664) < 2 && Math.abs(pw.r.height - 390) < 2, '转着时背包应铺满画面：' + JSON.stringify(pw));
  return '锁横屏 ' + (t0.lock ? '有' : '无') + ' → 旋转 ' + t1.st.rot + '（' + t1.vw + '×' + t1.vh + '），重载后接着转；走了 ' + (m.x - g0.x).toFixed(2) + ' m，主攻 ' + c.casts + ' 次，背包铺满' + (pre.settle ? '（量位移前先把手上的动作做完：' + pre.settle + ' 帧，' + JSON.stringify(pre.was) + '）' : '');
});

await step('iPhone 圆角：四角各一块半径 47 px 的遮罩，标题、职业选择、开场故事、HUD（提示卡、旁白卡、首领条、F 键）、背包、技能、暂停菜单、开场卡片的字和按钮都不碰', async () => {
  const c2 = await browser.newContext(Object.assign({}, dev));
  const p2 = await c2.newPage();
  const err2 = [];
  p2.on('pageerror', (e) => err2.push('pageerror: ' + (e.stack || e.message)));
  p2.on('response', (r) => {
    if (r.status() >= 400) err2.push('HTTP ' + r.status() + ' ' + r.url());
  });
  try {
    await p2.goto(GAME_URL);
    await p2.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
    const r = await cornerScenes(p2, [null]);
    if (process.env.WEBKIT_CORNER_SHOT) await p2.screenshot({ path: process.env.WEBKIT_CORNER_SHOT });
    // M2：按钮大小「大」+ 左手模式；竖着拿时的旋转横屏
    const vp = dev.viewport;
    const r2 = await cornerHud(p2, [[vp.width, vp.height, 'l', true], [390, 664, 'l', false, 'cw']]);
    r.lines.push(...r2.lines);
    r.bad.push(...r2.bad);
    assert(!err2.length, '页面报错：' + err2.join(' | '));
    assert(!r.bad.length, '有字或按钮碰到圆角：' + r.bad.join(' ｜ '));
    return r.lines.join('，');
  } finally {
    await c2.close();
  }
});

// UI-R B4b：用户的玩法是主屏幕 App、锁着自动旋转横着拿，游戏一直在旋转横屏里（用户截图 notes/user-feedback/iphone-rotated-title-2026-11-24.png）。
// iOS 主屏幕 App（状态栏 black-translucent）里网页从屏幕最顶上画起，innerHeight 却少算了状态栏那一截：这里照这个样子模拟（navigator.standalone、screen 是整块屏幕、innerHeight 少 59 px）
await step('旋转横屏 · 主屏幕 App（UI-R B4b）：iPhone 393×852 / 430×932，有没有状态栏 59 px + 底部横条 34 px 的安全区，布局视口少算状态栏时（test/devices.mjs 的模型）——画面盖满整块屏幕（±2 px）、画到屏幕底，3D 画布和叠加层也盖满；标题画面（有存档，6 个按钮）过 a–f、不碰圆角；HUD 和背包不碰圆角；方向记在设备上，重新打开接着转，⟲ 换过的方向也记住', async () => {
  const out = [];
  const bad = [];
  for (const [W, H] of [[393, 852], [430, 932]]) {
    for (const ins of [false, true]) {
      // rot-safe：换成 test/devices.mjs 的主屏幕 App 模型（原来只让 innerHeight 少 59 px，网页照样画满整块屏幕，查不出 2026-11-25 的黑边和被裁的 HUD）。
      // 安全区仍由下面的 setIns 按 ins 设；量圆角时 __ihBug 关掉（圆角按真的屏幕算）
      // rot-safe2：模型按真机读数改了（刚打开时整个视口少状态栏，随后 innerHeight / 可视区 / 100lvh 变成整块屏幕、clientHeight 不变），载入和重载走 launch()
      const sdev = { width: W, height: H, dpr: 3, sb: 59, hb: 34 };
      const c = await standaloneContext(browser, sdev, { safe: false });
      const where = W + '×' + H + (ins ? ' + 安全区' : '');
      const errs = [];
      try {
        let p = await c.newPage();
        p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
        const pev = (f, a) => p.evaluate(f, a);
        await launch(p, sdev, async () => {
          await p.goto(GAME_URL);
          await p.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
        });
        // 放一个存档（标题画面是 6 个按钮的样子），重新打开
        await pev(() => {
          const x = G.newClassSave('hunt');
          x.level = 7;
          x.seenHelp = x.seenStory = true;
          localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(x));
          localStorage.setItem(G.touch.keys.HINT_KEY, '1');
        });
        await launch(p, sdev, async () => {
          await p.reload();
          await p.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
        });
        const setIns = () => pev((on) => { const st = document.documentElement.style; for (const k of ['t', 'b']) { if (on) st.setProperty('--t-safe-' + k, k === 't' ? '59px' : '34px'); else st.removeProperty('--t-safe-' + k); } }, ins);
        await setIns();
        await pev(() => G.touch.setRot('cw'));
        await p.waitForTimeout(600);
        const fr = await pev(() => { const b = document.body.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; });
        if (Math.abs(fr.l) > 2 || Math.abs(fr.t) > 2 || Math.abs(fr.r - W) > 2 || Math.abs(fr.b - H) > 2) bad.push(where + ' 画面没盖满屏幕：' + JSON.stringify(fr));
        const pb = (await pev(rotFrameProbe, [[], PAINT_SRC])).paint.bottom;
        if (pb < H - 2) bad.push(where + ' 屏幕底下 ' + Math.round(H - pb) + ' px 没画到');
        const corner = async (what) => {
          await pev(() => { window.__ihBug = false; });
          const r = await pev(cornerCheck, { R: 47 });
          await pev(() => { window.__ihBug = true; });
          if (r.hits.length) bad.push(where + ' ' + what + ' 碰圆角：' + r.hits.slice(0, 3).map((x) => x.corner + ' ' + x.what).join('；'));
          // 有安全区时：状态栏（竖着的屏幕顶上 59 px，转过去是画面的左边）和底部横条（底下 34 px，画面的右边）那两条里不能有字和能点的东西
          if (ins) {
            const st = await pev(([H]) => {
              const out = [];
              const SEL = 'button, [data-act], [data-tact], [data-tb], [data-tt], .cell, .eq, .tab, input, select';
              for (const e of document.querySelectorAll('body *')) {
                if (!e.getClientRects().length) continue;
                const cs = getComputedStyle(e);
                if (cs.visibility === 'hidden' || cs.display === 'none') continue;
                let op = 1;
                for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
                if (op < 0.05) continue;
                const txt = Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
                if (!txt && !e.matches(SEL)) continue;
                const r = e.getBoundingClientRect(); // 屏幕坐标（竖着的）
                if (r.width < 1 || r.height < 1) continue;
                if (r.top < 59 - 0.5 || r.bottom > H - 34 + 0.5) out.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '')) + '「' + (e.textContent || '').trim().slice(0, 8) + '」 ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
              }
              return out;
            }, [H]);
            if (st.length) bad.push(where + ' ' + what + ' 有东西在状态栏 / 底部横条里：' + st.slice(0, 3).join('；'));
          }
        };
        const lay = await pev(uiLayoutCheck, { touch: true, roots: '#title .t-main, #title .t-foot, #t-rot-go, #t-rot-flip', head: '#title .m-head', max: 3 });
        if (lay.n) bad.push(where + ' 标题画面：' + Object.entries(lay.res).map(([k, v]) => k + ' ' + v.n + '（' + v.s.join('；') + '）').join(' '));
        const nBtn = await pev(() => Array.from(document.querySelectorAll('#t-menu .m-btn')).filter((n) => n.getClientRects().length).length);
        if (nBtn !== 6) bad.push(where + ' 标题画面应有 6 个按钮：' + nBtn);
        await corner('标题画面');
        // 进游戏：HUD、背包
        await pev(() => G.ui.hideTitle());
        await p.waitForTimeout(900);
        // rot-safe2：3D 画布和叠加层盖满整块屏幕、按画面尺寸渲染（be309c4 在真机上画布停在布局视口那么高）
        bad.push(...rotCanvasJudge(await pev(rotCanvasProbe), where));
        await corner('HUD');
        await pev(() => G.ui.open('inv'));
        await p.waitForTimeout(500);
        const li = await pev(uiLayoutCheck, { touch: true, max: 3 });
        if (li.n) bad.push(where + ' 背包：' + Object.entries(li.res).map(([k, v]) => k + ' ' + v.n + '（' + v.s.join('；') + '）').join(' '));
        await corner('背包');
        await pev(() => G.ui.close());
        // 方向记在设备上：关掉再打开（同一台设备 = 同一个浏览器配置），手机还竖着就接着按上次的方向转；⟲ 换过的也记住
        const k1 = await pev(() => localStorage.getItem(G.touch.keys.ROT_KEY));
        await p.close();
        p = await c.newPage();
        await p.goto(GAME_URL);
        await p.waitForFunction(() => window.G && G.touch && G.ui && G.ui.titleOn && G.ui.titleOn(), null, { timeout: 120000 });
        await p.waitForTimeout(400);
        const r1 = await p.evaluate(() => G.touch.state().rot);
        await p.evaluate(() => document.getElementById('t-rot-flip').click());
        await p.waitForTimeout(300);
        await p.close();
        p = await c.newPage();
        await p.goto(GAME_URL);
        await p.waitForFunction(() => window.G && G.touch && G.ui && G.ui.titleOn && G.ui.titleOn(), null, { timeout: 120000 });
        await p.waitForTimeout(400);
        const r2 = await p.evaluate(() => G.touch.state().rot);
        if (k1 !== 'cw' || r1 !== 'cw' || r2 !== 'ccw') bad.push(where + ' 方向没记住：' + JSON.stringify({ k1, r1, r2 }));
        await p.close();
        if (errs.length) bad.push(where + ' 页面报错：' + errs.join(' | '));
        out.push(where);
      } finally {
        await c.close();
      }
    }
  }
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return out.join(' / ') + '：画面盖满屏幕、标题 / HUD / 背包都过，方向记得住';
});

// rot-safe（2026-11-25）：用户在真机（iPhone 17 Pro 主屏幕 App、旋转横屏）上截到的是画面右边一条约 62 px 的黑边，小地图、主线追踪条、主攻键摆进黑边里被裁掉
// （notes/user-feedback/iphone-rotated-hud-clip-2026-11-25.png）。设备模型见 test/devices.mjs：布局视口比屏幕少状态栏，网页只画到文档盒子的底边。
// 打开时方向已经记在设备上（和真机一样走 restoreRot）；两个方向、三种屏幕
await step('旋转横屏 · 主屏幕 App · 可见区（rot-safe）：iPhone 17 Pro 402×874（默认）/ 393×852 / 375×812，cw / ccw，布局视口少状态栏、只画到文档盒子底边——屏幕底下没有没画到的条、画面盖满；小地图、主线追踪条、主攻键、技能键、翻滚、药瓶、顶栏整个在可见区里；状态栏和底部横条里没有字和按钮；设置里的「设备信息」点得开、字段齐', async () => {
  const out = [];
  const bad = [];
  for (const dev of STANDALONE_DEVICES) {
    for (const dir of ['cw', 'ccw']) {
      const where = dev.width + '×' + dev.height + ' ' + dir;
      const c = await standaloneContext(browser, dev, { rot: dir });
      const errs = [];
      try {
        const p = await c.newPage();
        p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
        p.on('response', (r) => {
          if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url());
        });
        const pev = (f, a) => p.evaluate(f, a);
        const ready = () => p.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
        await launch(p, dev, async () => {
          await p.goto(GAME_URL);
          await ready();
        });
        await pev(() => {
          const x = G.newClassSave('hunt');
          x.level = 7;
          x.seenHelp = x.seenStory = true;
          localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(x));
          localStorage.setItem(G.touch.keys.HINT_KEY, '1');
        });
        await launch(p, dev, async () => {
          await p.reload();
          await ready();
        });
        const rot = await pev(() => G.rot && G.rot.dir);
        if (rot !== dir) bad.push(where + ' 打开时没接着转：' + rot);
        await pev(() => G.ui.hideTitle());
        // rot-safe2：先等素材包、再按帧等追踪条（原来固定等 15 秒，机器忙时素材包没载完，375×812 偶尔报「主线追踪条没出来」）
        const qw = await questReady(p);
        if (qw) bad.push(where + ' ' + qw);
        await p.waitForTimeout(600);
        const o = await pev(rotFrameProbe, [HUD_PARTS, PAINT_SRC]);
        const j = rotFrameJudge(o, dev, where);
        bad.push(...j.bad);
        if (!qw && !o.parts.find((x) => x.name === '主线追踪条').boxes.length) bad.push(where + ' 主线追踪条没出来');
        // 设备信息（只在默认设备上点一次）：设置里收着，点开是一块等宽字，字段齐
        if (dev === MOBILE_DEFAULT && dir === 'cw') {
          await pev(() => G.ui.pause());
          await p.waitForTimeout(300);
          await pev(() => document.querySelector('#p-menu [data-tact="settings"]').click());
          await p.waitForTimeout(300);
          const row = await pev(() => !!document.querySelector('[data-tact="devinfo"]'));
          if (!row) bad.push(where + ' 设置里没有「设备信息」');
          else {
            const shut = await pev(() => !document.getElementById('m-dev'));
            await pev(() => document.querySelector('[data-tact="devinfo"]').click());
            await p.waitForTimeout(300);
            const txt = await pev(() => { const e = document.getElementById('m-dev'); return e && e.getClientRects().length ? e.textContent.replace(/ +/g, ' ') : ''; });
            // rot-safe2：真机上窗口、可视区是整块屏幕（874），只有 clientHeight 少状态栏；画到 / 画布 / 高度按新读数
            const miss = ['屏幕 402×874', '窗口 402×874', '可视区 402×874', '像素比 3', '安全区', '主屏幕 standalone true', '旋转 开 cw', '方向', '画面 874×402', '画布 874×402 · 缓冲', '渲染 874×402', '画到 画布到竖着的屏幕 y 874 · HUD 到 812 · 底边让出 62', '高度 clientHeight 812 · innerHeight 874 · 可视区 874 · 100lvh 874', 'html', 'clientHeight 812', '版本 v'].filter((k) => !txt.includes(k));
            if (!shut || miss.length) bad.push(where + ' 设备信息：' + (shut ? '' : '一开始没收着 ') + (miss.length ? '缺 ' + miss.join('、') : ''));
          }
        }
        if (errs.length) bad.push(where + ' 页面报错：' + errs.join(' | '));
        out.push(where + ' 画到 ' + Math.round(o.paint.bottom) + '/' + dev.height);
      } finally {
        await c.close();
      }
    }
  }
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return out.join('，') + '；HUD 都在可见区里，设备信息点得开';
});

// rot-safe2（2026-11-25）：rot-safe 上线后真机（be309c4）还是不对：3D 画布只画到竖着的屏幕 y 812，下面一条暗边，叠加层上的小地图被切，
// 主攻键、主线追踪条却画过了 812（notes/user-feedback/iphone-rotated-after-rotsafe-2026-11-25.png；设备信息：窗口 402×874、可视区 874、clientHeight 812）。
// 原因：刚打开时视口是 812，之后变成 874，world.js 的 resize 先跑、读到旧尺寸，画布停在 812；HUD 按 874 摆。
// 模型见 test/devices.mjs（standaloneContext + launch / settle）。在 be309c4 上这一步不过（画布到 812、小地图被切、主攻键伸出 812）
await step('旋转横屏 · 主屏幕 App · 画布铺满、HUD 在 clientHeight 以内（rot-safe2）：真机读数的模型（刚打开时视口少状态栏，随后 innerHeight / 可视区 / 100lvh 变成整块屏幕、clientHeight 不变），iPhone 17 Pro 402×874 cw / ccw、393×852 cw、375×812 cw——3D 画布和叠加层盖满整块屏幕、按画面尺寸渲染，小地图整个在叠加层里，HUD 和字都在 clientHeight 以内；「画面测试」打得开、七条色带和顶部对照齐、刷新就关', async () => {
  const out = [];
  const bad = [];
  const runs = [[STANDALONE_DEVICES[0], 'cw'], [STANDALONE_DEVICES[0], 'ccw'], [STANDALONE_DEVICES[1], 'cw'], [STANDALONE_DEVICES[2], 'cw']];
  let lateInfo = '';
  for (const [dev, dir] of runs) {
    const where = dev.width + '×' + dev.height + ' ' + dir;
    const c = await standaloneContext(browser, dev, { rot: dir });
    const errs = [];
    try {
      const p = await c.newPage();
      p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
      p.on('response', (r) => {
        if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url());
      });
      const pev = (f, a) => p.evaluate(f, a);
      const ready = () => p.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
      await launch(p, dev, async () => {
        await p.goto(GAME_URL);
        await ready();
      });
      await pev(() => {
        const x = G.newClassSave('hunt');
        x.level = 7;
        x.seenHelp = x.seenStory = true;
        localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(x));
        localStorage.setItem(G.touch.keys.HINT_KEY, '1');
      });
      await launch(p, dev, async () => {
        await p.reload();
        await ready();
      });
      await pev(() => G.ui.hideTitle());
      const qw = await questReady(p); // 先等素材包、再按帧等追踪条（HUD 检查要它在）
      if (qw) bad.push(where + ' ' + qw);
      await p.waitForTimeout(600);
      const o = await pev(rotCanvasProbe);
      bad.push(...rotCanvasJudge(o, where));
      const f = await pev(rotFrameProbe, [HUD_PARTS, PAINT_SRC]);
      bad.push(...rotFrameJudge(f, dev, where).bad);
      if (o.ch !== dev.height - dev.sb || o.ih !== dev.height) bad.push(where + ' 模型没生效：clientHeight ' + o.ch + ' innerHeight ' + o.ih);
      // 画面测试（只在默认设备 cw 上）：设置 → 设备信息 → 画面测试，色带齐；刷新就关
      if (dev === MOBILE_DEFAULT && dir === 'cw') {
        await pev(() => G.ui.pause());
        await p.waitForTimeout(300);
        await pev(() => document.querySelector('#p-menu [data-tact="settings"]').click());
        await p.waitForTimeout(300);
        await pev(() => document.querySelector('[data-tact="devinfo"]').click());
        await p.waitForTimeout(300);
        const sw = await pev(() => !!document.querySelector('[data-tact="devprobe"]'));
        if (!sw) bad.push(where + ' 设备信息里没有「画面测试」');
        else {
          await pev(() => document.querySelector('[data-tact="devprobe"]').click());
          await p.waitForTimeout(400);
          const pr = await pev(() => {
            const els = Array.from(document.querySelectorAll('.t-probe'));
            const txt = els.map((e) => e.textContent).join('|');
            return { n: els.length, txt, gl: G.world.probe && G.world.probe.gl, ov: G.world.probe && G.world.probe.ov, on: G.touch.probeOn(), html: getComputedStyle(document.documentElement).backgroundColor, clip: document.getElementById('gl').style.clipPath || document.getElementById('gl').style.webkitClipPath || '' };
          });
          const need = ['固定底', 'html 绝对', 'body 100lvh', 'html 底色', 'body 底色', '画布', '叠加层', '顶部对照'].filter((k) => !pr.txt.includes(k));
          if (!pr.on || need.length || !pr.gl || !pr.ov || !/polygon/.test(pr.clip) || !/255, 0, 255/.test(pr.html)) bad.push(where + ' 画面测试：' + JSON.stringify({ on: pr.on, n: pr.n, need, gl: !!pr.gl, ov: !!pr.ov, clip: pr.clip.slice(0, 20), html: pr.html }));
          // 3D 画布上那条在 clientHeight 以下（竖着的屏幕坐标）
          const gy = await pev((r) => { const a = G.toScreen(r[0], r[1]), b = G.toScreen(r[0] + r[2], r[1] + r[3]); return [Math.min(a.y, b.y), Math.max(a.y, b.y)]; }, pr.gl);
          if (!(gy[0] >= dev.height - dev.sb - 1 && gy[1] <= dev.height + 1)) bad.push(where + ' 画面测试的画布色带不在屏幕底那一截：' + gy.join('–'));
          await launch(p, dev, async () => {
            await p.reload();
            await ready();
          });
          const off = await pev(() => ({ on: G.touch.probeOn(), n: document.querySelectorAll('.t-probe').length, w: !!G.world.probe }));
          if (off.on || off.n || off.w) bad.push(where + ' 画面测试刷新后没关：' + JSON.stringify(off));
        }
      }
      // 晚长高（只在 375×812 上，zone-ready 全套里就是它停在 768）：resize 处理完 html 才长高、再没有事件，画面也要自己跟上
      if (dev === STANDALONE_DEVICES[2]) {
        await p.setViewportSize({ width: dev.width, height: dev.height - dev.sb });
        await converged(p, Object.assign({}, dev, { height: dev.height - dev.sb })).then((w) => { if (w) bad.push(where + ' 回到刚打开的视口没跟上：' + w); });
        const lg = await lateGrow(p, dev);
        if (lg.why) bad.push(where + ' 晚长高（resize 处理完 html 才长高，之后没有事件）：' + lg.why);
        else lateInfo = '；晚长高：先停在 ' + lg.stuck + '，自己跟上 ' + dev.height;
      }
      if (errs.length) bad.push(where + ' 页面报错：' + errs.join(' | '));
      out.push(where + ' 画布到 ' + Math.round(o.gl ? o.gl[3] : 0) + '、渲染 ' + (o.vs ? o.vs.w + '×' + o.vs.h : '?') + '、主角 x ' + (o.hero ? o.hero.fx : '?'));
    } finally {
      await c.close();
    }
  }
  assert(!bad.length, bad.length + ' 处不合格：' + bad.slice(0, 6).join(' ｜ '));
  return out.join('，') + '；HUD 在 clientHeight 以内，画面测试开得了、刷新就关' + lateInfo;
});

await browser.close();
console.log('\ntest:webkit ' + (failed ? '失败 ' + failed + ' 项，' : '') + '通过 ' + passed + ' 项');
process.exit(failed ? 1 : 0);
