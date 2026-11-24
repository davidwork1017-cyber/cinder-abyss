// WebKit 冒烟（mobile M1）：用 Playwright 的 WebKit（iPhone 横屏模拟）把手机上的主流程走一遍。
// iPhone 上的 Chrome 底下也是 WebKit：这里能查出 JS / CSS / WebGL2 的兼容问题；iOS 特有的 GPU、系统行为查不出来。
// 需要 Playwright 的 WebKit 浏览器（npx playwright@<playwright-core 的版本> install webkit），所以不在 npm test 里：
//   npm run test:webkit（开发机上：cc-slot pool <名字> smoke -- npm run test:webkit）
// 流程：载入 → 标题画面 → 新游戏选职业 → 进区 → 开场卡片（只这一张教程）→ 摇杆移动 → 按住主攻施法 → 第一次松手解锁声音 → 0 页面报错
// 最后换一个新的浏览器配置量 iPhone 圆角：标题、职业选择、开场故事、HUD、背包、技能、暂停菜单、开场卡片的字和按钮都不碰四角的圆角（test/corner-mask.mjs）
import { webkit, devices } from 'playwright-core';
import { execSync } from 'node:child_process';
import { GAME_URL, diagStep, outerTimeoutWarning } from './harness.mjs'; // 引入 harness 也就装上了它的信号处理：SIGTERM 时打 KILLED、立即退出
import { uiLayoutCheck, uiBlankPoint } from './ui-layout.mjs';
import { cornerScenes, cornerHud } from './corner-mask.mjs';

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

async function step(name, fn) {
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
  await tap('.cl-card[data-cls]');
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
  await tap('.cl-card[data-cls]');
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
    if (q.story && q.skip) await tap('.st-skip').catch(() => {});
    // 开场故事和开场卡片所有角色共用：前面那一步看过了，第二个角色就直接进游戏
    if (!q.story && !q.title && !q.open && (await ev(() => G.save.seenHelp && G.save.seenStory))) break;
    await page.waitForTimeout(700);
  }
  assert(q && (q.intro || (!q.story && !q.open)), '应进到游戏或开场卡片：' + JSON.stringify(q));
  const rot2 = await ev(() => G.touch.state().rot);
  if (q.intro) await tap('#intro-go');
  await page.waitForTimeout(600);
  if (await ev(() => G.touch.state().hint)) await tap('#t-hint-ok');
  await page.waitForTimeout(300);
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

await browser.close();
console.log('\ntest:webkit ' + (failed ? '失败 ' + failed + ' 项，' : '') + '通过 ' + passed + ' 项');
process.exit(failed ? 1 : 0);
