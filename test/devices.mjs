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
// 「过一会儿」：视口变成整块屏幕（innerHeight、visualViewport、100lvh = 屏幕高，发 resize），clientHeight 不变
export async function settle(p, dev = MOBILE_DEFAULT) {
  await p.setViewportSize({ width: dev.width, height: dev.height });
  await p.waitForTimeout(500);
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
