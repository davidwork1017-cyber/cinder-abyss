// 测试用：用系统 Chrome 无头打开游戏，收集报错
// 游戏经由本地静态 HTTP 服务打开（test/serve.mjs，和 GitHub Pages 一样按文件发），不是 file://。
// 要看 file:// 下的表现：CINDER_FILE=1 npm test（经典脚本 + base64 素材包，file:// 也能跑，但上线用的是 HTTP）。
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { serve } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let url0;
if (process.env.CINDER_FILE) url0 = pathToFileURL(path.join(root, 'index.html')).href;
else {
  // 随机端口；unref：测试脚本跑完、浏览器关掉后进程照常退出，不会被这个服务拖住
  const { server, url } = await serve();
  server.unref();
  url0 = url + 'index.html';
}
export const GAME_URL = url0;

// dpr：给游戏看的 window.devicePixelRatio（测试省渲染用，见 test/README.md「省渲染」）。每次导航前都装上；
// 页面里 sessionStorage 的 cinder-test-dpr 优先（单步临时改回 1 时重载页面也保持），null = 不改
// title：要不要显示标题画面。默认 false——测试和各种截图 / 计时脚本一进页面就和以前一样直接进区（每次导航前设 window.__skipTitle，
// 重载页面也一样跳过）；只有测标题画面本身的步骤传 title: true
// seed：测试用的确定性 Math.random（字符串，null = 不改，照旧是浏览器自己的随机数）。见下面的 installTestRandom 和 test/README.md「随机数」
// mobile：手机模拟（触屏步骤用）：{ scale: 3 } → isMobile + hasTouch + deviceScaleFactor，主指针变成 coarse、有触点，触屏模式自动打开
export async function launch({ width = 1440, height = 900, url = GAME_URL, title = false, dpr = null, seed = null, mobile = null } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
  });
  const page = await browser.newPage(
    mobile ? { viewport: { width, height }, deviceScaleFactor: mobile.scale || 3, isMobile: true, hasTouch: true } : { viewport: { width, height } }
  );
  if (!title) await page.addInitScript(() => { window.__skipTitle = true; });
  if (dpr)
    await page.addInitScript((d) => {
      let v = d;
      try {
        if (sessionStorage.getItem('cinder-test-dpr')) v = +sessionStorage.getItem('cinder-test-dpr');
      } catch (e) {}
      window.__testDpr = v;
      Object.defineProperty(window, 'devicePixelRatio', { get: () => window.__testDpr, configurable: true });
    }, dpr);
  if (seed !== null && seed !== undefined) await page.addInitScript(installTestRandom, String(seed));
  // sessionStorage 里有 cinder-test-hold 时，这一页一加载就暂停实时模拟（main.js 读 window.__simHold）：实时循环一帧模拟都不跑，
  // 同一个种子重载几次起点都一样（「确定性：帧快帧慢」那一步用；用完删掉这个键）
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('cinder-test-hold')) window.__simHold = true;
    } catch (e) {}
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.goto(url);
  return { browser, page, errors };
}

// 测试用的确定性 Math.random（每次导航前装上，在游戏脚本之前）。种子是一个字符串（test/smoke.mjs 用步骤名），哈希成两路 mulberry32：
// - 前台：测试脚本直接驱动的代码（page.evaluate 里的调用、G.tick / G.debug.step 推进的模拟、键盘鼠标事件的处理）
// - 后台：requestAnimationFrame / setTimeout / setInterval / requestIdleCallback 的回调（实时循环、空闲预热、定时器）
// 分开是因为后台回调跑几次取决于机器快慢：它们取的随机数不会挪动前台那一路，同一步在快机器和慢机器上前台拿到的序列一样。
// window.__testRand.seed(key)：从 key 重新开始两路序列，并把 Math.random 装回来（上一步没还原的 T.fix 之类不带进下一步）；
// key 记进 sessionStorage，这一步里重载页面也从同一个种子开始
function installTestRandom(seed0) {
  let key = seed0;
  try {
    const v = sessionStorage.getItem('cinder-test-seed');
    if (v !== null) key = v;
  } catch (e) {}
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const mk = (s) => {
    let a = s >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  let fg = null, bg = null, depth = 0;
  const random = function random() {
    return depth ? bg() : fg();
  };
  const R = {
    seed(k) {
      key = String(k);
      const h = hash(key);
      fg = mk(h);
      bg = mk(h ^ 0x5bd1e995);
      Math.random = random;
      try {
        sessionStorage.setItem('cinder-test-seed', key);
      } catch (e) {}
      return h;
    },
    key: () => key,
  };
  R.seed(key);
  for (const name of ['requestAnimationFrame', 'setTimeout', 'setInterval', 'requestIdleCallback']) {
    const orig = window[name];
    if (typeof orig !== 'function') continue;
    window[name] = function (cb, ...rest) {
      if (typeof cb !== 'function') return orig.call(window, cb, ...rest);
      return orig.call(
        window,
        function (...args) {
          depth++;
          try {
            return cb.apply(this, args);
          } finally {
            depth--;
          }
        },
        ...rest
      );
    };
  }
  Object.defineProperty(window, '__testRand', { value: R, configurable: true });
}

