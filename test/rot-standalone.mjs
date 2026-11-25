// 旋转横屏 · 主屏幕 App 的可见区检查（rot-safe，2026-11-25）。设备模型见 test/devices.mjs。
// 用户截图 notes/user-feedback/iphone-rotated-hud-clip-2026-11-25.png：画面右边（竖着的屏幕底下）一条约 62 px 的黑边，小地图、主线追踪条、主攻键摆进黑边里被裁掉。
import { paintRect } from './devices.mjs';

// HUD 里点名查的几样（小地图画在 2D 画布上，用一个按 W.mmTouch 摆的探针量）
export const HUD_PARTS = [
  ['小地图', '#__mm-probe'],
  ['主线追踪条', '#quest.on'],
  ['主攻键', '[data-tb="s0"]'],
  ['技能键', '[data-tb^="s"]'],
  ['翻滚', '[data-tb="roll"]'],
  ['药瓶', '[data-tb="f1"], [data-tb="f2"]'],
  ['顶栏', '#t-top'],
];

// 页面里跑：量真正画出来的范围、画面（body）盖住的范围、点名的 HUD 和所有带字 / 能点的东西，按竖着的屏幕坐标
export function rotFrameProbe([parts, paintSrc]) {
  const paint = (0, eval)('(' + paintSrc + ')')();
  const W = window.screen.width, H = window.screen.height;
  const b = document.body.getBoundingClientRect();
  const out = { W, H, paint, body: { l: b.left, t: b.top, r: b.right, b: b.bottom }, parts: [], text: [], icb: window.innerHeight };
  // 小地图探针
  let mp = document.getElementById('__mm-probe');
  if (!mp && document.body) {
    mp = document.createElement('div');
    mp.id = '__mm-probe';
    mp.style.cssText = 'position:fixed;width:110px;height:110px;pointer-events:none;visibility:hidden';
    document.body.appendChild(mp);
  }
  const mmT = window.G && G.world && G.world.mmTouch;
  if (mp && mmT) {
    mp.style.left = mmT.x + 'px';
    mp.style.top = mmT.y + 'px';
  }
  const vis = (e) => {
    if (!e.getClientRects().length) return false;
    const cs = getComputedStyle(e);
    if (cs.display === 'none') return false;
    let op = 1;
    for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
    return op >= 0.05;
  };
  const box = (e) => {
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * 10) / 10);
  };
  for (const [name, sel] of parts) {
    const els = Array.from(document.querySelectorAll(sel)).filter((e) => e.id === '__mm-probe' ? !!mmT : vis(e) && getComputedStyle(e).visibility !== 'hidden');
    out.parts.push({ name, sel, boxes: els.map(box) });
  }
  const SEL = 'button, [data-act], [data-tact], [data-tb], [data-tt], .cell, .eq, .tab, input, select';
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === '__mm-probe' || !vis(e) || getComputedStyle(e).visibility === 'hidden') continue;
    const txt = Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!txt && !e.matches(SEL)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.text.push({ what: (e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '')) + '「' + (e.textContent || '').trim().slice(0, 8) + '」', box: box(e) });
  }
  return out;
}
export const PAINT_SRC = paintRect.toString();
// 用法：const o = await page.evaluate(rotFrameProbe, [HUD_PARTS, PAINT_SRC])

// 判定（node 里）：dev = 设备预设；保底可见区 = 布局视口（屏幕高 − 状态栏），这一块真机上一定画得出来
export function rotFrameJudge(o, dev, where) {
  const bad = [];
  const { W, H, paint } = o;
  // 1. 没有没画到的条：画到屏幕底，画面（body）盖满整块屏幕
  if (paint.bottom < H - 1) bad.push(where + ' 屏幕底下 ' + Math.round(H - paint.bottom) + ' px 没画到（画到 ' + Math.round(paint.bottom) + ' / ' + H + '）');
  const fb = o.body;
  if (Math.abs(fb.l) > 2 || Math.abs(fb.t) > 2 || Math.abs(fb.r - W) > 2 || Math.abs(fb.b - H) > 2) bad.push(where + ' 画面没盖满屏幕：' + JSON.stringify(fb));
  // 2. 点名的 HUD 整个在可见区里：画出来的范围 ∩ 保底可见区（布局视口），左右在屏幕里
  const visB = Math.min(paint.bottom, dev.height - dev.sb + 0.5);
  const inside = (bx) => bx[0] >= -0.5 && bx[2] <= W + 0.5 && bx[1] >= -0.5 && bx[3] <= visB;
  const lines = [];
  for (const p of o.parts) {
    if (!p.boxes.length) {
      if (p.name !== '主线追踪条') bad.push(where + ' 找不到' + p.name + '（' + p.sel + '）');
      continue;
    }
    const out = p.boxes.filter((bx) => !inside(bx));
    if (out.length) bad.push(where + ' ' + p.name + '伸出可见区（可见到 y=' + Math.round(visB) + '）：' + out.slice(0, 2).map((bx) => bx.map(Math.round).join(',')).join('；'));
    lines.push(p.name + ' ' + p.boxes.length);
  }
  // 3. 状态栏（竖着的屏幕顶上 sb）和底部横条（底下 hb）里没有字和能点的东西；所有字和按钮也都在可见区里
  const sbHits = [], outHits = [];
  for (const t of o.text) {
    const bx = t.box;
    if (bx[2] < 0 || bx[0] > W || bx[3] < 0 || bx[1] > H) continue; // 在屏幕外（收起的抽屉之类）
    if (bx[1] < dev.sb - 0.5 || bx[3] > H - dev.hb + 0.5) sbHits.push(t.what + ' ' + bx.map(Math.round).join(','));
    else if (!inside(bx)) outHits.push(t.what + ' ' + bx.map(Math.round).join(','));
  }
  if (sbHits.length) bad.push(where + ' 状态栏 / 底部横条里有字或按钮：' + sbHits.slice(0, 3).join('；'));
  if (outHits.length) bad.push(where + ' 字或按钮伸出可见区：' + outHits.slice(0, 3).join('；'));
  return { bad, lines };
}

// 截图用：在 html 上（body 外面，不跟着转）盖一层：没画到的地方涂黑、状态栏示意；guides 时再画可见区和安全区
export function drawScreenOverlay([o, dev, guides]) {
  let ov = document.getElementById('__scr-ov');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = '__scr-ov';
  ov.style.cssText = 'position:fixed;left:0;top:0;width:' + o.W + 'px;height:' + o.H + 'px;z-index:2147483647;pointer-events:none;font:600 15px system-ui,sans-serif';
  const add = (css, html) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;box-sizing:border-box;' + css;
    if (html) d.innerHTML = html;
    ov.appendChild(d);
    return d;
  };
  // 没画到的地方（真机上是黑的）
  if (o.paint.bottom < o.H) add('left:0;right:0;top:' + o.paint.bottom + 'px;bottom:0;background:#000');
  // 状态栏示意（black-translucent：盖在画面上）
  add('left:0;right:0;top:0;height:' + dev.sb + 'px;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:8px 30px 0 44px', '<span>10:12</span><span>▮▮▮ ◔ 93</span>');
  // 底部横条示意
  add('left:50%;width:140px;margin-left:-70px;bottom:8px;height:5px;border-radius:3px;background:rgba(255,255,255,.75)');
  if (guides) {
    const visB = Math.min(o.paint.bottom, dev.height - dev.sb);
    add('left:0;right:0;top:0;height:' + dev.sb + 'px;background:repeating-linear-gradient(45deg,rgba(255,40,40,.35) 0 6px,transparent 6px 12px);border-bottom:2px solid #f33');
    add('left:0;right:0;bottom:0;height:' + dev.hb + 'px;background:repeating-linear-gradient(45deg,rgba(255,160,0,.35) 0 6px,transparent 6px 12px);border-top:2px solid #fa0');
    add('left:1px;right:1px;top:1px;height:' + (visB - 2) + 'px;border:2px dashed #3f6');
    for (const p of o.parts) for (const bx of p.boxes) add('left:' + bx[0] + 'px;top:' + bx[1] + 'px;width:' + (bx[2] - bx[0]) + 'px;height:' + (bx[3] - bx[1]) + 'px;border:2px solid #0cf');
    add('left:6px;top:' + (dev.sb + 4) + 'px;color:#3f6;font-size:11px;text-shadow:0 0 3px #000', '可见到 y=' + Math.round(visB) + ' · 状态栏 ' + dev.sb + ' · 横条 ' + dev.hb + ' · 画到 y=' + Math.round(o.paint.bottom));
  }
  document.documentElement.appendChild(ov);
}
