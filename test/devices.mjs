// 手机测试的设备预设（rot-safe，2026-11-25）。以后的手机 / WebKit 检查默认用 IPHONE_17_PRO（用户的真机：6.3 英寸，402×874 pt，@3x，灵动岛）。
// 用户的玩法：主屏幕 App（standalone，状态栏 black-translucent），手机横着拿、锁着自动旋转，游戏在旋转横屏里（docs/ui.md「手机设备预设」）。
//
// iOS 主屏幕 App 的视口模型（用户截图 2026-11-24 / 2026-11-25 对出来的，见 docs/ui.md）：
//   - 网页从屏幕最顶上画起（状态栏盖在上面），screen 是整块屏幕；
//   - 布局视口（初始包含块）却少了状态栏那一截：innerHeight、visualViewport.height、documentElement.clientHeight、html / body 的 100% 高都是 屏幕高 − 状态栏；
//   - 100vh / 100lvh 是整块屏幕高；
//   - 真正画出来的只到文档盒子的底边 = max(布局视口, html 盒子, 不是 fixed 的 body 盒子)；再往下是黑的，fixed 的东西伸过去也被裁掉。
//   这样 2026-11-24（画面按 innerHeight 摆）是「底下一条黑边、HUD 完整」，2026-11-25（画面按 screen.height 摆）是「同一条黑边，HUD 摆进黑边里被裁掉」。
import { devices } from 'playwright-core';

// sb：状态栏（竖着时 env(safe-area-inset-top)），hb：底部横条（env(safe-area-inset-bottom)），单位 CSS px
export const IPHONE_17_PRO = { name: 'iPhone 17 Pro', width: 402, height: 874, dpr: 3, sb: 62, hb: 34 };
export const IPHONE_16 = { name: 'iPhone 15 / 16', width: 393, height: 852, dpr: 3, sb: 59, hb: 34 };
export const IPHONE_X = { name: 'iPhone X / 11 Pro', width: 375, height: 812, dpr: 3, sb: 44, hb: 34 };
export const MOBILE_DEFAULT = IPHONE_17_PRO;
export const STANDALONE_DEVICES = [IPHONE_17_PRO, IPHONE_16, IPHONE_X];

// 竖着的主屏幕 App（standalone）的浏览器配置：视口 = 整块屏幕，页面里按上面的模型把布局视口改短 sb。
// rot：'cw' / 'ccw' 时先在设备上记好旋转方向（cinder-abyss-rot），打开就进旋转横屏（和真机一样走 restoreRot）
// safe：安全区（这个 WebKit 里 env() 都是 0，用游戏认的 --t-safe-t / --t-safe-b 假装状态栏和底部横条）
// window.__ihBug = false 时这些改动全部关掉（量圆角时按真的屏幕算）
export async function standaloneContext(browser, dev = MOBILE_DEFAULT, { rot = null, safe = true } = {}) {
  const c = await browser.newContext(
    Object.assign({}, devices['iPhone 13'], {
      viewport: { width: dev.width, height: dev.height },
      screen: { width: dev.width, height: dev.height },
      deviceScaleFactor: dev.dpr,
    })
  );
  await c.addInitScript(([sb, hb, rot, safe]) => {
    Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    window.__ihBug = true;
    window.__sb = sb;
    const short = (v) => (window.__ihBug ? v - sb : v);
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight') || Object.getOwnPropertyDescriptor(Window.prototype, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { get() { return short(ih.get.call(window)); }, configurable: true });
    const ch = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'clientHeight', { get() { const v = ch.get.call(this); return this === document.documentElement ? short(v) : v; }, configurable: true });
    if (window.VisualViewport) {
      const vh = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
      if (vh) Object.defineProperty(VisualViewport.prototype, 'height', { get() { return short(vh.get.call(this)); }, configurable: true });
    }
    // html / body 的 100% 高跟着布局视口短一截（100vh / 100lvh 不动，还是整块屏幕）
    const css = () => {
      let s = document.getElementById('__icb');
      if (!s) {
        s = document.createElement('style');
        s.id = '__icb';
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent = window.__ihBug ? ':root:root { height: calc(100% - ' + sb + 'px); }' : '';
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
  }, [dev.sb, dev.hb, rot, safe]);
  return c;
}

// 页面里跑：按上面的模型算真正画出来的范围（屏幕坐标，竖着的）
export function paintRect() {
  const de = document.documentElement, b = document.body;
  const icb = window.innerHeight; // 模拟里已经是短的布局视口
  let bottom = Math.max(icb, de.getBoundingClientRect().bottom);
  if (getComputedStyle(b).position !== 'fixed') bottom = Math.max(bottom, b.getBoundingClientRect().bottom);
  return { left: 0, top: 0, right: window.screen.width, bottom: Math.min(bottom, window.screen.height) };
}
