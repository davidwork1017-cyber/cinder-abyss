// WebKit 冒烟（mobile M1）：用 Playwright 的 WebKit（iPhone 横屏模拟）把手机上的主流程走一遍。
// iPhone 上的 Chrome 底下也是 WebKit：这里能查出 JS / CSS / WebGL2 的兼容问题；iOS 特有的 GPU、系统行为查不出来。
// 需要 Playwright 的 WebKit 浏览器（npx playwright@<playwright-core 的版本> install webkit），所以不在 npm test 里：
//   npm run test:webkit（开发机上：cc-slot pool <名字> smoke -- npm run test:webkit）
// 流程：载入 → 标题画面 → 新游戏选职业 → 进区 → 开场卡片（只这一张教程）→ 摇杆移动 → 按住主攻施法 → 第一次松手解锁声音 → 0 页面报错
// 最后换一个新的浏览器配置量 iPhone 圆角：标题、职业选择、开场故事、HUD、背包、技能、暂停菜单、开场卡片的字和按钮都不碰四角的圆角（test/corner-mask.mjs）
import { webkit, devices } from 'playwright-core';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { GAME_URL } from './harness.mjs';
import { uiLayoutCheck, uiBlankPoint } from './ui-layout.mjs';
import { cornerScenes, cornerHud, cornerCheck } from './corner-mask.mjs';

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

const browser = await webkit.launch({ headless: true });
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

async function step(name, fn) {
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

await step('面板布局（UI-R B1）：844×340 / 390×844 下背包（空、筛选、说明、物品卡）、仓库（格子、物品卡）、属性（属性、图鉴）都过 a–f 检查（test/ui-layout.mjs），点卡片外面能收起', async () => {
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
    for (const x of document.querySelectorAll('#panel-win, #panel-win *, #panel .sheet')) for (const a of x.getAnimations()) await a.finished.catch(() => {});
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
    ];
    for (const [id, open, taps, card] of states) {
      n++;
      try {
        await ev(([t, sub]) => { G.ui.close(); G.ui.open(t, sub); }, open);
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
    G.debug.hold(false); // 准备时按住了模拟（布局检查不用它跑）：还回去，后面的步骤要看游戏在跑
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
// 第二圈就该平了：再涨就是有东西没释放。实测第二圈相对第一圈 −60…+40 MB（噪声），没释放整区的东西时一圈要多出好几百 MB
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
await step('内存：低档连走五个区两圈（每区打首领、清怪），回收后第二圈 WebProcess 的 RSS 涨不过 ' + RSS_LAP2_MB + ' MB，几何体 / 贴图 / 程序回到第一圈的水平；第二圈再进区没有一次贴图上传超过 ' + UPLOAD_MAX_MS + ' ms，烬渊深渊底的贴图传像素、和传画布逐像素相同', async () => {
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
    for (let lap = 0; lap < 2; lap++) {
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
  const [l1, l2] = laps;
  // 贴图留 6 张余量：有些全局贴图第一次用到才建、建了就一直留着（异兆道具的环 / 符文这类随机出现的东西可能第二圈才第一次碰到）；漏掉整区的贴图一圈是几十张
  assert(l2.geo - l1.geo <= 3 && l2.tex - l1.tex <= 6 && l2.prog - l1.prog <= 3, '第二圈没回到第一圈的水平：' + JSON.stringify(laps));
  assert(l2.upMs <= UPLOAD_MAX_MS, '第二圈有一次贴图上传 ' + l2.upMs + ' ms（' + l2.upAt + '）');
  assert(deep && deep.via === 'data' && deep.data === deep.canvas, '烬渊深渊底的贴图应传像素、和传画布逐像素相同：' + JSON.stringify(deep));
  if (l1.rss != null && l2.rss != null) assert(l2.rss - l1.rss <= RSS_LAP2_MB, '回收后第二圈 WebProcess 涨了 ' + (l2.rss - l1.rss).toFixed(0) + ' MB：' + JSON.stringify(laps));
  const rss = l1.rss != null ? 'WebProcess ' + l1.rss.toFixed(0) + ' → ' + l2.rss.toFixed(0) + ' MB（' + (l2.rss - l1.rss >= 0 ? '+' : '') + (l2.rss - l1.rss).toFixed(0) + '）' : 'RSS 量不到（不是 Linux）';
  return rss + ' ｜ 几何体 ' + l1.geo + ' → ' + l2.geo + '，贴图 ' + l1.tex + ' → ' + l2.tex + '，程序 ' + l1.prog + ' → ' + l2.prog + ' ｜ 最长一次贴图上传 第一圈 ' + l1.upMs + ' ms（' + l1.upAt + '）/ 第二圈 ' + l2.upMs + ' ms（' + l2.upAt + '） ｜ 深渊底传像素 ' + deep.dataMs + ' ms / 传画布 ' + deep.canvasMs + ' ms';
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
      return { story: G.ui.storyOn(), intro: document.getElementById('intro').classList.contains('on'), skip: !!(n && n.getBoundingClientRect().width > 0), title: G.ui.titleOn(), open: G.ui.isOpen(), rot: G.touch.state().rot, cls: document.documentElement.className, view: G.ui.classView && G.ui.classView(), url: location.search };
    });
    if (q.intro) break;
    // 已经点过「跳过」、故事在淡出 / 收起：不再点（淡完那一刻点下去会落到游戏里的攻击键上，测试自己挥一下；同 chrome-hunt 的修法）
    if (q.story && q.skip && !(await ev(() => G.story && G.story.info && G.story.info().ended))) await tap('.st-skip').catch(() => {});
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
  await touch('touchstart', '#t-stick', 0, 0);
  await touch('touchmove', '#t-stick', 0, 50 * sy);
  await page.waitForTimeout(300);
  // 按住时按模拟时间推进 0.3 秒量位移（按墙钟等的话，机器忙时一秒只跑几帧，走的距离不定）
  const m = await ev(() => {
    const x0 = G.player.x;
    G.debug.step(0.3);
    return { mv: G.input.move && { x: G.input.move.x, z: G.input.move.z, k: G.input.move.k }, x: G.player.x, dx: G.player.x - x0, sp: G.player.moveSpeed };
  });
  await touch('touchend', '#t-stick', 0, 50 * sy);
  assert(m.mv && m.mv.x > 0.95 && m.dx > 0.3 * m.sp * 0.7, '转着时摇杆往画面右边拖应往右走：' + JSON.stringify({ g0, m }));
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
  return '锁横屏 ' + (t0.lock ? '有' : '无') + ' → 旋转 ' + t1.st.rot + '（' + t1.vw + '×' + t1.vh + '），重载后接着转；走了 ' + (m.x - g0.x).toFixed(2) + ' m，主攻 ' + c.casts + ' 次，背包铺满';
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
await step('旋转横屏 · 主屏幕 App（UI-R B4b）：iPhone 393×852 / 430×932，有没有状态栏 59 px + 底部横条 34 px 的安全区，innerHeight 少算状态栏时——画面盖满整块屏幕（±2 px）；标题画面（有存档，6 个按钮）过 a–f、不碰圆角；HUD 和背包不碰圆角；方向记在设备上，重新打开接着转，⟲ 换过的方向也记住', async () => {
  const out = [];
  const bad = [];
  for (const [W, H] of [[393, 852], [430, 932]]) {
    for (const ins of [false, true]) {
      const c = await browser.newContext(Object.assign({}, devices['iPhone 13'], { viewport: { width: W, height: H }, screen: { width: W, height: H } }));
      await c.addInitScript((short) => {
        Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
        const d = Object.getOwnPropertyDescriptor(window, 'innerHeight') || Object.getOwnPropertyDescriptor(Window.prototype, 'innerHeight');
        window.__ihBug = true; // 量圆角时关掉（圆角按真的屏幕算）
        Object.defineProperty(window, 'innerHeight', { get() { const v = d.get.call(window); return window.__ihBug ? Math.min(v, short) : v; }, configurable: true });
      }, H - 59);
      const where = W + '×' + H + (ins ? ' + 安全区' : '');
      const errs = [];
      try {
        let p = await c.newPage();
        p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
        const pev = (f, a) => p.evaluate(f, a);
        await p.goto(GAME_URL);
        await p.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
        // 放一个存档（标题画面是 6 个按钮的样子），重新打开
        await pev(() => {
          const x = G.newClassSave('hunt');
          x.level = 7;
          x.seenHelp = x.seenStory = true;
          localStorage.setItem('cinder-abyss-save-v1', JSON.stringify(x));
          localStorage.setItem(G.touch.keys.HINT_KEY, '1');
        });
        await p.reload();
        await p.waitForFunction(() => window.G && G.ui && G.ui.titleOn && G.ui.titleOn() && document.getElementById('title').classList.contains('ready'), null, { timeout: 120000 });
        const setIns = () => pev((on) => { const st = document.documentElement.style; for (const k of ['t', 'b']) { if (on) st.setProperty('--t-safe-' + k, k === 't' ? '59px' : '34px'); else st.removeProperty('--t-safe-' + k); } }, ins);
        await setIns();
        await pev(() => G.touch.setRot('cw'));
        await p.waitForTimeout(600);
        const fr = await pev(() => { const b = document.body.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; });
        if (Math.abs(fr.l) > 2 || Math.abs(fr.t) > 2 || Math.abs(fr.r - W) > 2 || Math.abs(fr.b - H) > 2) bad.push(where + ' 画面没盖满屏幕：' + JSON.stringify(fr));
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

await browser.close();
console.log('\ntest:webkit ' + (failed ? '失败 ' + failed + ' 项，' : '') + '通过 ' + passed + ' 项');
process.exit(failed ? 1 : 0);
