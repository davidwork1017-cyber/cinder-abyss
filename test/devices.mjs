// 手机测试的设备预设（rot-safe，2026-11-25）。以后的手机 / WebKit 检查默认用 IPHONE_17_PRO（用户的真机：6.3 英寸，402×874 pt，@3x，灵动岛）。
// 用户的玩法：主屏幕 App（standalone，状态栏 black-translucent），手机横着拿、锁着自动旋转，游戏在旋转横屏里（docs/ui.md「手机设备预设」）。
//
// iOS 主屏幕 App 的视口模型（rot-safe2 按真机读数重做，2026-11-25；rot-safe 的旧模型说 innerHeight / visualViewport 也少一截，真机上不是）：
//   - 网页从屏幕最顶上画起（状态栏盖在上面），screen 是整块屏幕；
//   - 刚打开时整个视口少状态栏那一截（innerHeight、visualViewport、100vh / 100lvh、初始包含块都是 屏幕高 − 状态栏）；
//   - 过一会儿 innerHeight、visualViewport、100lvh 变成整块屏幕高（发 resize），documentElement.clientHeight（初始包含块）、html / body 的 100% 高
//     却一直是 屏幕高 − 状态栏。真机读数（be309c4）：窗口 402×874 · 可视区 402×874 · clientHeight 812 · html 高 874（min-height 100lvh）；
//   - 真正画出来的只到文档盒子的底边 = max(初始包含块, html 盒子, 不是 fixed 的 body 盒子)；再往下没有内容（ui-b4b：body fixed、html 812，整个 HUD 在 812 被裁）。
//   be309c4 在这个模型下和用户截图一样：world.js 的 resize 先跑、读到旧的 812，画布停在 812（右边一条暗边，叠加层上的小地图被切），
//   touch.js 随后把画面量成 874，HUD 摆到 874（主攻键、主线追踪条画过 812）。
// 用法：standaloneContext 建出来是「刚打开」的视口；页面载好以后 settle() 一下（视口变成整块屏幕），重载用 launch()。
import { devices } from 'playwright-core';

// sb：状态栏（竖着时 env(safe-area-inset-top)），hb：底部横条（env(safe-area-inset-bottom)），单位 CSS px
export const IPHONE_17_PRO = { name: 'iPhone 17 Pro', width: 402, height: 874, dpr: 3, sb: 62, hb: 34 };
export const IPHONE_16 = { name: 'iPhone 15 / 16', width: 393, height: 852, dpr: 3, sb: 59, hb: 34 };
export const IPHONE_X = { name: 'iPhone X / 11 Pro', width: 375, height: 812, dpr: 3, sb: 44, hb: 34 };
export const MOBILE_DEFAULT = IPHONE_17_PRO;
export const STANDALONE_DEVICES = [IPHONE_17_PRO, IPHONE_16, IPHONE_X];

// 竖着的主屏幕 App（standalone）的浏览器配置：screen = 整块屏幕，视口先少 sb（刚打开），settle() 以后变成整块屏幕；clientHeight 和 html 的 100% 一直少 sb。
// rot：'cw' / 'ccw' 时先在设备上记好旋转方向（cinder-abyss-rot），打开就进旋转横屏（和真机一样走 restoreRot）
// safe：安全区（这个 WebKit 里 env() 都是 0，用游戏认的 --t-safe-t / --t-safe-b 假装状态栏和底部横条）
// window.__ihBug = false 时 clientHeight / html 高的改动关掉（量圆角时按真的屏幕算）
export async function standaloneContext(browser, dev = MOBILE_DEFAULT, { rot = null, safe = true } = {}) {
  const c = await browser.newContext(
    Object.assign({}, devices['iPhone 13'], {
      viewport: { width: dev.width, height: dev.height - dev.sb },
      screen: { width: dev.width, height: dev.height },
      deviceScaleFactor: dev.dpr,
    })
  );
  await c.addInitScript(([sb, hb, H, rot, safe]) => {
    Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    window.__ihBug = true;
    window.__sb = sb;
    const icb = H - sb; // 初始包含块的高：一直少状态栏
    const ch = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'clientHeight', { get() { const v = ch.get.call(this); return this === document.documentElement && window.__ihBug ? Math.min(v, icb) : v; }, configurable: true });
    // html / body 的 100% 高跟着初始包含块（100vh / 100lvh 照视口走）
    const css = () => {
      let s = document.getElementById('__icb');
      if (!s) {
        s = document.createElement('style');
        s.id = '__icb';
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent = window.__ihBug ? ':root:root { height: ' + icb + 'px; }' : '';
      if (safe) {
        document.documentElement.style.setProperty('--t-safe-t', sb + 'px');
        document.documentElement.style.setProperty('--t-safe-b', hb + 'px');
      }
    };
    window.__icbCss = css;
    if (document.documentElement) css();
    else {
      const mo = new MutationObserver(() => {
        if (!document.documentElement) return;
        mo.disconnect();
        css();
      });
      mo.observe(document, { childList: true });
    }
    if (rot) {
      try {
        if (!localStorage.getItem('cinder-abyss-rot-seeded')) {
          localStorage.setItem('cinder-abyss-rot', rot);
          localStorage.setItem('cinder-abyss-rot-seeded', '1');
        }
      } catch (e) {}
    }
  }, [dev.sb, dev.hb, dev.height, rot, safe]);
  return c;
}
// 「过一会儿」：视口变成整块屏幕（innerHeight、visualViewport、100lvh = 屏幕高，发 resize），clientHeight 不变。
// 然后按帧等页面跟上（rot-safe2）：innerHeight 是整块屏幕；旋转横屏的主屏幕 App 里画面高 = 视口高（html 撑到 100lvh）；3D 画布 = 画面。
// 最多等 120 帧（touch.js 每 30 帧兜底重量一次，够 4 轮）；没跟上就报哪一条没满足（不靠固定时长，也不重试）
export async function settle(p, dev = MOBILE_DEFAULT) {
  await p.setViewportSize({ width: dev.width, height: dev.height });
  const why = await converged(p, dev);
  if (why) throw new Error(why);
}
// 按帧等页面跟上整块屏幕（见 settle）；返回空串 = 跟上了，否则是哪一条没满足
export async function converged(p, dev = MOBILE_DEFAULT) {
  const h = await p.waitForFunction(([H]) => {
    window.__settleN = (window.__settleN || 0) + 1;
    let why = '';
    if (window.innerHeight !== H) why = 'innerHeight ' + window.innerHeight + ' ≠ ' + H;
    else if (window.G && G.viewW && G.world && document.getElementById('gl')) {
      const v = G.touch && G.touch.view ? G.touch.view() : null;
      const fw = Math.round(G.viewW()), fh = Math.round(G.viewH());
      if (G.rot && v && v.stand && fw !== H) why = '画面高 ' + fw + ' ≠ 视口 ' + H + '（上次量时 html ' + v.html + '，现在 html ' + Math.round(document.documentElement.getBoundingClientRect().height) + '、innerHeight ' + window.innerHeight + '）';
      else {
        const r = G.rectToFrame(document.getElementById('gl').getBoundingClientRect());
        if (Math.abs(r.width - fw) > 1 || Math.abs(r.height - fh) > 1) why = '3D 画布 ' + Math.round(r.width) + '×' + Math.round(r.height) + ' ≠ 画面 ' + fw + '×' + fh;
      }
    }
    if (!why || window.__settleN >= 120) {
      const n = window.__settleN;
      window.__settleN = 0;
      return { why, n };
    }
    return false;
  }, [dev.height], { polling: 'raf', timeout: 300000 });
  const r = await h.jsonValue();
  return r.why ? '视口变成整块屏幕后 ' + r.n + ' 帧还没跟上：' + r.why : '';
}
// 晚长高（rot-safe2，zone-ready 的 webkit 全套里 375×812 画面停在 768 的那种情况）：视口变大、resize 事件处理完的时候 html 盒子还没长高，
// 之后 html 才长高、不再有事件。用一条样式把 html 先按在刚打开的高（拿掉 min-height 100lvh），视口变大后过几帧再拿掉（拿掉不发事件），看页面自己跟不跟得上
export async function lateGrow(p, dev = MOBILE_DEFAULT) {
  await p.evaluate((h) => {
    const s = document.createElement('style');
    s.id = '__late-grow';
    s.textContent = 'html.t-stand { min-height: 0 !important; height: ' + h + 'px !important; }'; // min-height 比 max-height 优先，只能把 min-height 拿掉
    document.head.appendChild(s);
  }, dev.height - dev.sb);
  await p.setViewportSize({ width: dev.width, height: dev.height });
  await p.waitForFunction(() => { window.__lgN = (window.__lgN || 0) + 1; if (window.__lgN < 10) return false; window.__lgN = 0; return true; }, null, { polling: 'raf', timeout: 120000 });
  const stuck = await p.evaluate(() => Math.round(G.viewW()));
  await p.evaluate(() => document.getElementById('__late-grow').remove());
  const why = await converged(p, dev);
  return { stuck, why };
}
// 主线追踪条（rot-safe2）：它要等区域的素材包载完才淡入（ui.js：assetsLoading / assetsPending 为假），所以先等素材包，再按帧等 #quest.on。
// 返回空串 = 出来了；否则说清是哪一步没到（不靠固定时长）
export async function questReady(p) {
  const loaded = await p
    .waitForFunction(() => { const w = G.world, f = w.assetsLoading || w.assetsPending; return !(f && f.call(w)); }, null, { timeout: 120000 })
    .then(() => true, () => false);
  if (!loaded) return '素材包 120 秒还没载完（主线追踪条要等它）';
  // 出来 = 有 .on 而且 0.3 秒的淡入走完（不透明度 ≥ 0.95）。原来只等 .on、再固定等 600 ms：机器忙时 WebKit 一帧很慢，淡入还没走完，
  // 可见区检查量到的不透明度不到 0.05，报「主线追踪条没出来」（pickup-feed 查到，main 91e8fe4 上一样）。按帧等，最多 120 帧
  const h = await p.waitForFunction(() => {
    window.__qN = (window.__qN || 0) + 1;
    const q = document.getElementById('quest');
    const on = !!(q && q.classList.contains('on'));
    const op = q ? +getComputedStyle(q).opacity : 0;
    if ((on && op >= 0.95) || window.__qN >= 120) {
      const n = window.__qN, Q = G.save && G.save.quest;
      window.__qN = 0;
      return { on, op, n, q: Q ? 'n ' + Q.n + (Q.off ? ' off' : '') : '无', title: !!(G.ui.titleOn && G.ui.titleOn()) };
    }
    return false;
  }, null, { polling: 'raf', timeout: 120000 });
  const r = await h.jsonValue();
  if (r.on && r.op >= 0.95) return '';
  return '素材包已载完，' + r.n + ' 帧后主线追踪条' + (r.on ? '还没淡入（不透明度 ' + r.op + '）' : '还没出来') + '（主线 ' + r.q + '，标题画面 ' + r.title + '）';
}
// 重新打开（载入 / 重载）：先回到刚打开的视口，go() 等页面好了，再 settle()
export async function launch(p, dev, go) {
  await p.setViewportSize({ width: dev.width, height: dev.height - dev.sb });
  await go();
  await settle(p, dev);
}

// 页面里跑：按上面的模型算真正画出来的范围（屏幕坐标，竖着的）
export function paintRect() {
  const de = document.documentElement, b = document.body;
  const icb = de.clientHeight; // 初始包含块（模拟里一直少状态栏）
  let bottom = Math.max(icb, de.getBoundingClientRect().bottom);
  if (getComputedStyle(b).position !== 'fixed') bottom = Math.max(bottom, b.getBoundingClientRect().bottom);
  return { left: 0, top: 0, right: window.screen.width, bottom: Math.min(bottom, window.screen.height) };
}
