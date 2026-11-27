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
  const out = { W, H, paint, body: { l: b.left, t: b.top, r: b.right, b: b.bottom }, parts: [], text: [], icb: document.documentElement.clientHeight };
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

// 判定（node 里）：dev = 设备预设；HUD 的界 = 屏幕高 − 底部横条（t45：真机「画面测试」截图证明 clientHeight 以下那一截画得出来；
// rot-safe2 时是布局视口 = 屏幕高 − 状态栏）
export function rotFrameJudge(o, dev, where) {
  const bad = [];
  const { W, H, paint } = o;
  // 1. 没有没画到的条：画到屏幕底，画面（body）盖满整块屏幕
  if (paint.bottom < H - 1) bad.push(where + ' 屏幕底下 ' + Math.round(H - paint.bottom) + ' px 没画到（画到 ' + Math.round(paint.bottom) + ' / ' + H + '）');
  const fb = o.body;
  if (Math.abs(fb.l) > 2 || Math.abs(fb.t) > 2 || Math.abs(fb.r - W) > 2 || Math.abs(fb.b - H) > 2) bad.push(where + ' 画面没盖满屏幕：' + JSON.stringify(fb));
  // 2. 点名的 HUD 整个在可见区里：画出来的范围 ∩ 保底可见区（布局视口），左右在屏幕里
  const visB = Math.min(paint.bottom, dev.height - dev.hb + 0.5);
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

// rot-safe2：画布（用户截图 2026-11-25：3D 画布只画到 812，叠加层上的小地图被切，DOM 的主攻键、主线追踪条画过 812）。
// 页面里跑：3D 画布 / 叠加层在竖着的屏幕上的矩形、world 按多大渲染、画面多大、小地图（叠加层上画的，按 W.mmTouch）的矩形、主攻键 / 主线追踪条的底边
export function rotCanvasProbe() {
  const r = (e) => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * 10) / 10);
  };
  const vs = G.world.viewSize ? G.world.viewSize() : null;
  const mt = G.world.mmTouch;
  let mm = null;
  if (mt) {
    const a = G.toScreen(mt.x, mt.y), c = G.toScreen(mt.x + 110, mt.y + 110);
    mm = [Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y)];
  }
  // 主角在画面上的位置（镜头对着主角：画布只有 812 宽时它在 406，铺满时在 437；用户截图里约 405）
  let hero = null;
  try {
    const P = G.player;
    const v = new THREE.Vector3(P.x, 1, P.z).project(G.world.camera);
    const fr = G.rectToFrame(document.getElementById('gl').getBoundingClientRect()); // 画布在画面里实际多大
    hero = { fx: Math.round(((v.x + 1) / 2) * fr.width), fy: Math.round(((1 - v.y) / 2) * fr.height) };
  } catch (e) {}
  return {
    W: window.screen.width, H: window.screen.height, ch: document.documentElement.clientHeight, ih: window.innerHeight,
    gl: r(document.getElementById('gl')), ov: r(document.getElementById('overlay')),
    vs, frame: [G.viewW(), G.viewH()], mm, hero,
    s0: r(document.querySelector('[data-tb="s0"]')), quest: r(document.querySelector('#quest.on .q-goal') || document.querySelector('#quest.on')),
    view: G.touch.view ? G.touch.view() : null,
  };
}
// 判定（node 里）：画布和叠加层盖满整块屏幕（±1）、按画面尺寸渲染，小地图整个在叠加层里
export function rotCanvasJudge(o, where) {
  const bad = [];
  const cover = (b) => b && b[0] <= 1 && b[1] <= 1 && b[2] >= o.W - 1 && b[3] >= o.H - 1;
  if (!cover(o.gl)) bad.push(where + ' 3D 画布没盖满屏幕：' + JSON.stringify(o.gl) + '（屏幕 ' + o.W + '×' + o.H + '）');
  if (!cover(o.ov)) bad.push(where + ' 叠加层没盖满屏幕：' + JSON.stringify(o.ov));
  // 渲染尺寸只在有 G.world.viewSize 的版本上对（老版本只看上面的盖满）
  if (o.vs && (o.vs.w !== Math.max(1, o.frame[0]) || o.vs.h !== Math.max(1, o.frame[1]))) bad.push(where + ' 渲染尺寸 ' + o.vs.w + '×' + o.vs.h + ' 和画面 ' + o.frame.join('×') + ' 对不上');
  if (o.mm && o.ov && (o.mm[0] < o.ov[0] - 0.5 || o.mm[1] < o.ov[1] - 0.5 || o.mm[2] > o.ov[2] + 0.5 || o.mm[3] > o.ov[3] + 0.5)) bad.push(where + ' 小地图伸出叠加层（被切）：小地图 ' + o.mm.map(Math.round).join(',') + '，叠加层 ' + o.ov.map(Math.round).join(','));
  return bad;
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
    const visB = Math.min(o.paint.bottom, dev.height - dev.hb);
    add('left:0;right:0;top:0;height:' + dev.sb + 'px;background:repeating-linear-gradient(45deg,rgba(255,40,40,.35) 0 6px,transparent 6px 12px);border-bottom:2px solid #f33');
    add('left:0;right:0;bottom:0;height:' + dev.hb + 'px;background:repeating-linear-gradient(45deg,rgba(255,160,0,.35) 0 6px,transparent 6px 12px);border-top:2px solid #fa0');
    add('left:1px;right:1px;top:1px;height:' + (visB - 2) + 'px;border:2px dashed #3f6');
    for (const p of o.parts) for (const bx of p.boxes) add('left:' + bx[0] + 'px;top:' + bx[1] + 'px;width:' + (bx[2] - bx[0]) + 'px;height:' + (bx[3] - bx[1]) + 'px;border:2px solid #0cf');
    add('left:6px;top:' + (dev.sb + 4) + 'px;color:#3f6;font-size:11px;text-shadow:0 0 3px #000', '可见到 y=' + Math.round(visB) + ' · 状态栏 ' + dev.sb + ' · 横条 ' + dev.hb + ' · 画到 y=' + Math.round(o.paint.bottom) + (o.glB ? ' · 画布到 y=' + Math.round(o.glB) : ''));
    if (o.glB && o.glB < o.H - 1) add('left:0;right:0;top:' + (o.glB - 1) + 'px;height:0;border-top:2px dashed #f0f', '<span style="position:absolute;right:6px;top:2px;color:#f0f;font-size:11px">画布底 y=' + Math.round(o.glB) + '</span>');
  }
  document.documentElement.appendChild(ov);
}

// 画面测试的七条色带（t45）：截一张图，在屏幕底那一截（clientHeight 到屏幕底）每条取四个点（左右各一列 × 离底 4 / 12 px，躲开中间的字），看颜色对不对。
// 真机截图（2026-11-26，标题画面）里叠加层那条是空的：标题画面把叠加层藏了。画面测试开着时现在放出来。
// 标题画面的暗色渐变盖在 html / body 底色、画布、叠加层上（竖着的屏幕底边在 cw 时是渐变最淡的一头），所以只比颜色的比例
export const PROBE_HUES = [
  ['固定底', ([r, g, b]) => r > 120 && r > g * 1.6 && r > b * 1.6],
  ['html 绝对', ([r, g, b]) => r > 120 && g > b * 2 && r > g * 1.3],
  ['body 100lvh', ([r, g, b]) => r > 120 && g > b * 2 && g > r * 0.7],
  ['html 底色', ([r, g, b]) => r > g * 2 + 8 && b > g * 2 + 8],
  ['body 底色', ([r, g, b]) => g > r * 2 + 8 && b > r * 2 + 8],
  ['画布', ([r, g, b]) => g > r * 2 + 8 && g > b * 2 + 8],
  ['叠加层', ([r, g, b]) => b > r * 2 + 8 && b > g * 1.5 + 4],
];
export async function probeBand(p, dev) {
  const buf = await p.screenshot();
  return p.evaluate(async ([b64, dpr]) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    // 和 touch.js 的 probeGeom 一样的摆法（竖着的屏幕坐标）
    const sw = window.screen.width, sh = window.screen.height, top = Math.min(document.documentElement.clientHeight, sh - 62);
    const x0 = Math.round(sw * 0.125), cw = Math.floor((sw - 2 * x0) / 7);
    const out = [];
    for (let i = 0; i < 7; i++) {
      const pts = [];
      for (const x of [x0 + i * cw + 4, x0 + i * cw + cw - 7]) for (const y of [sh - 4, sh - 12]) pts.push(Array.from(g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data).slice(0, 3));
      out.push(pts);
    }
    return { top, out };
  }, [buf.toString('base64'), dev.dpr]);
}
// 判定：only = 只查这几条的下标（缺省七条都查）
export function probeBandJudge(r, where, only) {
  const bad = [];
  PROBE_HUES.forEach(([name, ok], i) => {
    if (only && !only.includes(i)) return;
    const miss = r.out[i].filter((px) => !ok(px));
    if (miss.length) bad.push(where + ' 画面测试「' + name + '」那条在屏幕底那一截没画出来：' + miss.slice(0, 2).map((px) => px.join(',')).join('；'));
  });
  return bad;
}
