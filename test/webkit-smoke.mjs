// WebKit 冒烟（mobile M1）：用 Playwright 的 WebKit（iPhone 横屏模拟）把手机上的主流程走一遍。
// iPhone 上的 Chrome 底下也是 WebKit：这里能查出 JS / CSS / WebGL2 的兼容问题；iOS 特有的 GPU、系统行为查不出来。
// 需要 Playwright 的 WebKit 浏览器（npx playwright@<playwright-core 的版本> install webkit），所以不在 npm test 里：
//   npm run test:webkit（开发机上：cc-slot pool <名字> smoke -- npm run test:webkit）
// 流程：载入 → 标题画面 → 新游戏选职业 → 进区 → 开场卡片（只这一张教程）→ 摇杆移动 → 按住主攻施法 → 第一次松手解锁声音 → 0 页面报错
// 最后换一个新的浏览器配置量 iPhone 圆角：标题、职业选择、开场故事、HUD、背包、技能、暂停菜单、开场卡片的字和按钮都不碰四角的圆角（test/corner-mask.mjs）
import { webkit, devices } from 'playwright-core';
import { execSync } from 'node:child_process';
import { GAME_URL } from './harness.mjs';
import { cornerScenes } from './corner-mask.mjs';

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
  await tap('.cl-card[data-cls]');
  await tap('[data-tact="cl-ok"]');
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
  const k = await ev(() => ({ d: !!G.input.keys.KeyD, x: G.player.x }));
  await touch('touchend', '#t-stick', 10, 40);
  const a = await ev(() => {
    const c = G.audio.ctx();
    return { ctx: !!c, state: c ? c.state : null, keys: Object.keys(G.input.keys).filter((q) => G.input.keys[q]) };
  });
  assert(k.d && k.x > x0 + 0.3, '摇杆没让玩家往右走：' + JSON.stringify({ x0, k }));
  assert(!a.keys.length, '松手后还有按着的键：' + a.keys);
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
