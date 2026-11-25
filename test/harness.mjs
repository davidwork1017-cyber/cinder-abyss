// 测试用：用系统 Chrome 无头打开游戏，收集报错
// 游戏经由本地静态 HTTP 服务打开（test/serve.mjs，和 GitHub Pages 一样按文件发），不是 file://。
// 要看 file:// 下的表现：CINDER_FILE=1 npm test（经典脚本 + base64 素材包，file:// 也能跑，但上线用的是 HTTP）。
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdirSync, appendFileSync, writeSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { serve } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ 浏览器体检（test/README.md「Chrome 中途退出」）
// 每次运行一个目录 test-logs/<UTC 时间>-<pid>/（CINDER_CHROME_LOG=<目录> 可改）：
//   run.log          开 / 关浏览器、意外退出、收到的信号，一行一件事，带时间和当时的步骤名
//   chrome-NNN.log   第 N 个浏览器的启动命令、pid、Chrome 自己的 stderr（--enable-logging=stderr）、进程退出码 / 信号
//   crash/           Chrome 的崩溃转储（--crash-dumps-dir），有的话意外退出时列出来
// 浏览器不是测试关掉的却断开了：控制台打一段 CHROME-DIED（第几个浏览器、哪一步开的、死在哪一步、活了多久、退出码 / 信号、stderr 最后几行）。
// 进程收到 SIGTERM / SIGHUP / SIGINT（外层 timeout 到点、被杀）：打一行 KILLED 后立即退出（143 / 129 / 130），浏览器一起关掉。
// 以前 Playwright 自己接 SIGTERM：只关浏览器、进程不退，后面的步骤拿着关掉的浏览器报「browser has been closed」，像是 Chrome 中途崩了
const RUN_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + process.pid;
const LOGS = path.join(root, 'test-logs');
export const LOG_DIR = process.env.CINDER_CHROME_LOG || path.join(LOGS, RUN_ID);
const diag = { step: '准备', n: 0, t0: Date.now(), deaths: [], ready: false, quitting: false };
const hhmmss = () => new Date().toISOString().slice(11, 23) + 'Z';
function logDir() {
  if (diag.ready) return LOG_DIR;
  diag.ready = true;
  try {
    mkdirSync(path.join(LOG_DIR, 'crash'), { recursive: true });
  } catch (e) {}
  // 只留最近 3 天的运行目录（名字是 RUN_ID 的样子才动）
  if (!process.env.CINDER_CHROME_LOG)
    try {
      for (const d of readdirSync(LOGS)) {
        const p = path.join(LOGS, d);
        if (/^\d{8}T\d{6}Z-\d+$/.test(d) && p !== LOG_DIR && Date.now() - statSync(p).mtimeMs > 3 * 864e5) rmSync(p, { recursive: true, force: true });
      }
    } catch (e) {}
  return LOG_DIR;
}
function runLog(msg) {
  try {
    appendFileSync(path.join(logDir(), 'run.log'), hhmmss() + ' ' + msg + '\n');
  } catch (e) {}
}
// 测试脚本在每一步开始时告诉这里步骤名（记进日志、意外退出时报出来）
export function diagStep(name) {
  diag.step = name;
}
// 本次运行里意外断开的浏览器：[{ id, pid, born, step, at, aliveS, exit, tail }]
export const browserDeaths = diag.deaths;
// 一条报错里有「browser has been closed」之类时，补上最近一次意外退出的说明（没有就返回空串）
export function deathNote(msg) {
  if (!/has been closed|Target crashed|Browser closed|disconnected/i.test(String(msg)) || !diag.deaths.length) return '';
  const d = diag.deaths[diag.deaths.length - 1];
  return ' ｜浏览器 #' + d.id + '（pid ' + d.pid + '）' + d.at + ' 已意外退出' + (d.exit ? '（' + d.exit + '）' : '') + '，详见 ' + path.relative(root, LOG_DIR) + '/run.log';
}
const say = (s) => {
  try {
    writeSync(1, s + '\n'); // 同步写：进程马上就要退出时 console.log 可能丢
  } catch (e) {}
};
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
for (const sig of Object.keys(SIGNALS))
  process.on(sig, () => {
    if (diag.quitting) return;
    diag.quitting = true;
    const s = Math.round((Date.now() - diag.t0) / 1000);
    const line = 'KILLED 收到 ' + sig + '（' + new Date().toISOString() + '，已运行 ' + s + ' 秒，正在跑「' + diag.step.slice(0, 80) + '」）——本次结果作废，退出码 ' + (128 + SIGNALS[sig]) + '。常见原因：外层 timeout 到点（它从排队时就开始算）';
    say(line);
    runLog(line);
    process.exit(128 + SIGNALS[sig]); // Playwright 在退出时杀掉它开的所有 Chrome
  });
// 外层 timeout 检查（Linux）：往上找祖先进程里的 `timeout N …`，按它启动的时刻算还剩多少秒；
// 剩下的不到 needMin 分钟（这份测试正常耗时的两倍左右）就返回一行警告，没有就返回空串。只提醒，不改结果
export function outerTimeoutWarning(needMin) {
  try {
    const tick = 100; // USER_HZ，Linux 上都是 100
    const uptime = parseFloat(readFileSync('/proc/uptime', 'utf8'));
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // 从第 3 个字段（state）开始
      const args = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
      if (path.basename(args[0] || '') === 'timeout') {
        const dur = args.slice(1).find((a) => !a.startsWith('-') && /^\d+(\.\d+)?[smhd]?$/.test(a));
        if (dur) {
          const sec = parseFloat(dur) * ({ s: 1, m: 60, h: 3600, d: 86400 }[dur.slice(-1)] || 1);
          const ranS = uptime - +rest[19] / tick; // 第 22 个字段 starttime
          const left = Math.round(sec - ranS);
          if (left < needMin * 60)
            return 'WARN 外层 `timeout ' + dur + '`（pid ' + pid + '）只剩 ' + Math.round(left / 60) + ' 分钟，这份测试正常要跑到 ' + needMin + ' 分钟才算稳：到点会收到 SIGTERM、本次作废。把限时放进槽位里：cc-slot pool <名字> <类> --wait 360 -- timeout <秒> npm run …（test/README.md「Chrome 中途退出」）';
        }
        return '';
      }
      pid = +rest[1];
    }
  } catch (e) {}
  return '';
}

let url0;
if (process.env.CINDER_FILE) url0 = pathToFileURL(path.join(root, 'index.html')).href;
else {
  // 随机端口；unref：测试脚本跑完、浏览器关掉后进程照常退出，不会被这个服务拖住
  const { server, url } = await serve();
  server.unref();
  url0 = url + 'index.html';
}
export const GAME_URL = url0;

// 开一个无头 Chrome，带上体检（见上面「浏览器体检」）。别的脚本要自己开 Chrome 也可以用它
// Chrome 本体：CINDER_CHROME_BIN 优先，否则 Linux 上 Google Chrome 的安装位置。找得到就经 test/chrome-log.sh 起（stderr 进日志），
// 找不到（比如 Mac）就照旧用 channel: 'chrome'，只是没有 stderr 日志
const CHROME_BIN = [process.env.CINDER_CHROME_BIN, '/opt/google/chrome/chrome'].find((p) => {
  try {
    return p && statSync(p).isFile();
  } catch (e) {
    return false;
  }
});
const CHROME_WRAP = path.join(root, 'test', 'chrome-log.sh');
const readTail = (file, n) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch (e) {
    return [];
  }
};

// 开一个无头 Chrome，带上体检（见上面「浏览器体检」）。别的脚本要自己开 Chrome 也可以用它
export async function launchChrome(args = []) {
  const id = ++diag.n;
  const born = diag.step, bornT = Date.now();
  const file = path.join(logDir(), 'chrome-' + String(id).padStart(3, '0') + '.log');
  let closing = false;
  try {
    appendFileSync(file, hhmmss() + ' 开在「' + born + '」' + (CHROME_BIN ? '' : '（没找到 Chrome 本体，stderr 不记）') + '\n');
  } catch (e) {}
  const browser = await chromium.launch(
    Object.assign(CHROME_BIN ? { executablePath: CHROME_WRAP, env: Object.assign({}, process.env, { CINDER_CHROME_BIN: CHROME_BIN, CINDER_CHROME_STDERR: file }) } : { channel: 'chrome' }, {
      headless: true,
      args: [...args, '--enable-logging=stderr', '--v=0', '--crash-dumps-dir=' + path.join(logDir(), 'crash')],
      // 信号由上面的 process.on 处理（记一行再退出）；交给 Playwright 的话它只关浏览器、进程照跑
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    })
  );
  const pidOf = () => (readTail(file, 400).join('\n').match(/<chrome pid=(\d+)>/) || [])[1] || '?';
  const pid = pidOf();
  runLog('launch #' + id + ' pid ' + pid + ' 「' + born.slice(0, 80) + '」');
  const close0 = browser.close.bind(browser);
  browser.close = (o) => {
    closing = true;
    return close0(o);
  };
  browser.on('disconnected', () => {
    if (closing || diag.quitting) {
      runLog('close #' + id + ' pid ' + pid);
      return;
    }
    const d = { id, pid, born, step: diag.step, at: new Date().toISOString(), aliveS: Math.round((Date.now() - bornT) / 1000), exit: '', tail: [] };
    diag.deaths.push(d);
    // 启动壳在 Chrome 退出之后才写退出码，等一下再读
    setTimeout(() => {
      d.tail = readTail(file, 25);
      const rc = (d.tail.join('\n').match(/<chrome exit rc=(\d+)>/) || [])[1];
      d.exit = rc === undefined ? '没有退出码（启动壳也一起没了：整个进程组被杀）' : +rc > 128 ? '被信号 ' + (+rc - 128) + ' 杀掉（rc ' + rc + '）' : '退出码 ' + rc;
      let dumps = [];
      try {
        dumps = readdirSync(path.join(LOG_DIR, 'crash'), { recursive: true }).filter((f) => /\.dmp$/.test(f));
      } catch (e) {}
      const head = 'CHROME-DIED 浏览器 #' + id + '（pid ' + pid + '，开在「' + born.slice(0, 50) + '」）在「' + d.step.slice(0, 50) + '」时意外断开，' + d.at + '（活了 ' + d.aliveS + ' 秒），' + d.exit + (dumps.length ? '，崩溃转储 ' + dumps.length + ' 个' : '');
      runLog(head + '\n' + d.tail.map((l) => '    ' + l).join('\n'));
      say(head + '\n' + d.tail.slice(-12).map((l) => 'CHROME-DIED   ' + l.slice(0, 300)).join('\n') + '\nCHROME-DIED   全部日志：' + path.relative(root, file));
    }, 800).unref();
  });
  return browser;
}

// dpr：给游戏看的 window.devicePixelRatio（测试省渲染用，见 test/README.md「省渲染」）。每次导航前都装上；
// 页面里 sessionStorage 的 cinder-test-dpr 优先（单步临时改回 1 时重载页面也保持），null = 不改
// title：要不要显示标题画面。默认 false——测试和各种截图 / 计时脚本一进页面就和以前一样直接进区（每次导航前设 window.__skipTitle，
// 重载页面也一样跳过）；只有测标题画面本身的步骤传 title: true
// seed：测试用的确定性 Math.random（字符串，null = 不改，照旧是浏览器自己的随机数）。见下面的 installTestRandom 和 test/README.md「随机数」
// mobile：手机模拟（触屏步骤用）：{ scale: 3 } → isMobile + hasTouch + deviceScaleFactor，主指针变成 coarse、有触点，触屏模式自动打开
export async function launch({ width = 1440, height = 900, url = GAME_URL, title = false, dpr = null, seed = null, mobile = null } = {}) {
  const browser = await launchChrome(['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio']);
  const page = await browser.newPage(
    mobile ? { viewport: { width, height }, deviceScaleFactor: mobile.scale || 3, isMobile: true, hasTouch: true } : { viewport: { width, height } }
  );
  page.on('crash', () => runLog('page crash（渲染进程崩了）「' + diag.step.slice(0, 80) + '」'));
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

