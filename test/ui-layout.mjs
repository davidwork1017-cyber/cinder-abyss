// 面板布局检查（UI-R，B1 搭框架，B2–B4 往里加面板）。uiLayoutCheck 在页面里跑（page.evaluate），返回不合格项的列表。
// 规则见 docs/ui.md「测试」：
//   a. 文字和点按目标都在视口里；只有 [data-list] 区域里、滚得到的才算例外
//   b. 面板里只有 [data-list] 能纵向溢出（#panel-win、#panel-body、各栏 scrollHeight == clientHeight）
//   c. 页面没有横向溢出
//   d. 触屏：页头 ≤ 36 px；字号 ≥ 11 px；button / [data-act] / .cell / .tab 的盒子 ≥ 44×44（桌面只查字号）
//   e. elementFromPoint 打到每个点按目标的中心，打到的是它自己（或它里面的东西）
//   f. 卡片整个在页面正文里、不盖页头和页签；卡片 / 弹出菜单打开时，里面的操作条整个在视口里（「点外面关掉」由调用方去点）
// opts：{ touch: bool, roots: '#panel-win, …'（默认 #panel-win 和面板里的浮层）, max: 每类最多列几条 }
export function uiLayoutCheck(opts) {
  const o = Object.assign({ touch: false, roots: '#panel-win, #panel .sheet, #panel .ui-pop, #confirm.on', max: 6 }, opts || {});
  // 旋转横屏（mobile-m2）：位置换到画面坐标（G.rectToFrame / viewW / viewH）；elementFromPoint 用屏幕坐标。没有这几个函数时就是原样
  const G0 = window.G || {};
  const F = (r) => (G0.rectToFrame ? G0.rectToFrame(r) : r);
  const BR = (e) => F(e.getBoundingClientRect());
  const vw = G0.viewW ? G0.viewW() : innerWidth, vh = G0.viewH ? G0.viewH() : innerHeight;
  const out = { a: [], b: [], c: [], d: [], e: [], f: [] };
  const R = (r) => [r.left, r.top, r.right, r.bottom].map(Math.round).join(',');
  const vis = (e) => {
    for (let p = e; p && p.nodeType === 1; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    }
    const r = e.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const nm = (e) => {
    const t = (e.getAttribute('data-act') ? '[' + e.getAttribute('data-act') + ']' : '') + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    const txt = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 10);
    return (t || e.tagName.toLowerCase()) + (txt ? '「' + txt + '」' : '');
  };
  const scrollerOf = (e) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX) && p !== document.body && p !== document.documentElement) return p;
    }
    return null;
  };
  const roots = Array.from(new Set(o.roots.split(',').flatMap((s) => Array.from(document.querySelectorAll(s.trim()))))).filter(vis);
  const seen = new Set();
  const TARGET = 'button, [data-act], [data-tact], .cell, .eq, .tab, input, select, .tn';
  const targets = [];
  for (const root of roots) {
    for (const e of [root, ...root.querySelectorAll('*')]) {
      if (seen.has(e)) continue;
      seen.add(e);
      if (!vis(e)) continue;
      const cs = getComputedStyle(e);
      const r = BR(e);
      const txt = Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      const isT = e.matches(TARGET) && !e.disabled && !e.closest('[inert]');
      // b：只有 data-list 能纵向溢出
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2 && !e.hasAttribute('data-list') && e.clientHeight > 0)
        out.b.push(nm(e) + ' ' + e.clientHeight + '/' + e.scrollHeight);
      // d：字号
      if (txt && parseFloat(cs.fontSize) < 10.95) out.d.push('字号 ' + cs.fontSize + ' ' + nm(e));
      if (!txt && !isT) continue;
      // a：在视口里（data-list 里滚得到的除外；被别的祖先裁掉也算出界）
      let clip = { l: 0, t: 0, r: vw, b: vh };
      let inList = null;
      for (let p = scrollerOf(e); p; p = scrollerOf(p)) {
        const pr = BR(p);
        if (p.hasAttribute('data-list') && !inList) inList = p;
        clip = { l: Math.max(clip.l, pr.left), t: Math.max(clip.t, pr.top), r: Math.min(clip.r, pr.right), b: Math.min(clip.b, pr.bottom) };
      }
      const outVp = r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1;
      const outClip = r.left < clip.l - 1 || r.top < clip.t - 1 || r.right > clip.r + 1 || r.bottom > clip.b + 1;
      if (outVp || outClip) {
        // data-list 里：滚过去就看得见（列表本身在视口里、元素宽度放得下）。横着滑的 data-list（B4a 地图的区域卡片一排）：列表整个在视口里、元素高度放得下
        const lr = inList && BR(inList);
        const hz = inList && /(auto|scroll)/.test(getComputedStyle(inList).overflowX) && /(hidden|clip)/.test(getComputedStyle(inList).overflowY);
        const reach = inList && lr.top >= -1 && lr.bottom <= vh + 1 && (hz ? lr.left >= -1 && lr.right <= vw + 1 && r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1 : r.left >= lr.left - 1 && r.right <= lr.right + 1);
        if (!reach) out.a.push(nm(e) + ' ' + R(r) + (outVp ? ' 视口外' : ' 被裁'));
        continue;
      }
      if (isT) targets.push(e);
    }
  }
  // c：横向溢出
  if (document.documentElement.scrollWidth > innerWidth + 0.5) out.c.push('页面横向 ' + document.documentElement.scrollWidth + ' > ' + vw);
  // d：页头、点按区
  if (o.touch) {
    const head = document.getElementById('panel-head');
    if (head && vis(head) && BR(head).height > 36.5) out.d.push('页头 ' + Math.round(BR(head).height) + ' px');
    for (const e of targets) {
      const r = BR(e);
      if (r.width < 43.5 || r.height < 43.5) out.d.push('点按区 ' + Math.round(r.width) + '×' + Math.round(r.height) + ' ' + nm(e));
    }
  }
  // e：elementFromPoint
  for (const e of targets) {
    if (e.matches('.cell.empty, .eq.empty') && !e.dataset.act) continue;
    const r = e.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === e || e.contains(hit))) continue;
    // 打开着的卡片 / 小菜单 / 确认框本来就盖在页面上：被它们盖住的格子不算（它们自己里面的按钮照查）
    const ov = hit && hit.closest('#panel .sheet, #panel .ui-pop, #confirm');
    if (ov && !ov.contains(e)) continue;
    out.e.push(nm(e) + ' 被 ' + (hit ? nm(hit) : '空') + ' 挡住');
  }
  // f：卡片整个在页面正文里（不盖页头 / 页签、不出面板），操作条在视口里
  const body = document.getElementById('panel-body'), head = document.getElementById('panel-head');
  for (const sh of document.querySelectorAll('#panel .sheet')) {
    if (!vis(sh) || !body) continue;
    const r = BR(sh), b = BR(body), hd = BR(head);
    if (r.left < b.left - 1 - 16 || r.right > b.right + 1 + 16 || r.top < b.top - 1 || r.bottom > b.bottom + 1) out.f.push('卡片出了正文 ' + R(r) + ' / 正文 ' + R(b));
    if (r.top < hd.bottom - 0.5 && r.bottom > hd.top && r.left < hd.right && r.right > hd.left) out.f.push('卡片盖住了页头 ' + R(r));
  }
  // f：卡片 / 弹出菜单的操作条在视口里
  for (const bar of document.querySelectorAll('#panel .sheet .sh-acts, #panel .ui-pop')) {
    if (!vis(bar)) continue;
    const r = BR(bar);
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) out.f.push(nm(bar) + ' ' + R(r));
  }
  const res = {};
  let n = 0;
  for (const k in out) {
    n += out[k].length;
    if (out[k].length) res[k] = { n: out[k].length, s: out[k].slice(0, o.max) };
  }
  return { n, res, vw, vh };
}

// 每个尺寸：[宽, 高, 触屏?, 安全区 px, 旋转]。触屏横屏各跑一组 59 px 安全区（iOS 横屏刘海）和一组 0；竖屏的安全区在上下，不加左右
export const UI_SIZES = [
  [844, 340, true, 0], [844, 340, true, 59],
  [667, 320, true, 0], [667, 320, true, 59],
  [734, 338, true, 0], [734, 338, true, 59],
  [1000, 450, true, 0], [1000, 450, true, 59],
  [390, 844, true, 0], [390, 844, true, 59],
  [390, 844, true, 0, 'cw'], // 竖着拿、画面转 90° 的旋转横屏（mobile-m2 的 G.touch.setRot），画面是 844×390
  [1920, 1080, false, 0], [1366, 768, false, 0], [1280, 720, false, 0],
];

// 「点卡片外面」用的点：页面正文里、不在卡片 / 小菜单下面、离点按目标最远的空白处（手机会把点在目标旁边的一下吸到目标上），
// 离最近的目标至少 10 px。在页面里跑；找不到返回 null
export function uiBlankPoint() {
  const body = document.getElementById('panel-body');
  const b = body.getBoundingClientRect();
  const over = Array.from(document.querySelectorAll('#panel .sheet, #panel .ui-pop')).map((n) => n.getBoundingClientRect());
  const tg = Array.from(document.querySelectorAll('#panel button, #panel [data-act], #panel .cell, #panel .eq')).filter((n) => n.getClientRects().length).map((n) => n.getBoundingClientRect());
  const gap = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  let best = null;
  for (let y = b.top + 3; y < b.bottom - 3; y += 4)
    for (let x = b.left + 3; x < b.right - 3; x += 4) {
      if (over.some((r) => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4)) continue;
      const d = Math.min(...tg.map((r) => gap(x, y, r)));
      if (best && d <= best.d) continue;
      const h = document.elementFromPoint(x, y);
      if (h && body.contains(h) && !h.closest('.sheet, .ui-pop')) best = { x, y, d };
    }
  return best && best.d >= 10 ? best : null;
}

// 桌面样式不变（UI-R B1）：1366×768 下这些元素的计算样式和 main（7cf4f95）逐项相等。数值是在 main 上量的（vf-shots/ui-b1/styles-main.json），
// 有意改动的几项不在表里或已改成新值：.c-ilvl 10.5 → 11 px（最小字号 11）；.chk（含魔法 / 含稀有）挪进「筛选」菜单；底部常驻的操作说明并进一次性提示；
// 「char 」开头的在「属性」页签里量（main 上属性表在背包页）
export const DESK_STYLE_SPEC = {"#panel-win": ["width", "height", "background-image", "border-top-color"], "#panel-head": ["height", "padding-left", "padding-right", "background-image", "border-bottom-color"], ".brand": ["width", "font-size", "letter-spacing", "color", "font-family"], ".tab": ["font-size", "letter-spacing", "padding-left", "padding-right", "color", "font-family", "font-weight"], ".tab.on": ["color", "text-shadow"], ".tab kbd": ["font-size", "opacity"], "#panel-close": ["width", "font-size", "color"], "#panel-body": ["padding-top", "padding-left", "padding-bottom"], ".sec-title": ["height", "font-size", "letter-spacing", "color", "font-family", "margin-bottom"], ".sec-note": ["font-size", "color"], ".eq-grid": ["width", "column-gap"], ".eq": ["width", "height", "border-top-color", "border-radius", "background-image"], ".eq-name": ["font-size", "color"], ".bag .cell": ["width", "height", "border-radius", "box-shadow"], ".bag": ["column-gap", "row-gap"], ".c-ilvl": ["font-size", "color"], ".cur": ["height", "width", "font-size", "border-top-color", "background-color"], ".cur b": ["font-size"], ".btn.sm": ["height", "font-size", "padding-left", "letter-spacing"], ".inv-tips": ["font-size", "padding-top", "border-top-color"], "char .st-row": ["font-size", "line-height", "color", "letter-spacing"], "char .st-row b": ["font-size", "line-height", "color", "letter-spacing"], "char .st-group": ["font-size", "line-height", "color", "letter-spacing"]};
export const DESK_STYLE_MAIN = {"#panel-win|width": "1280px", "#panel-win|height": "706.5px", "#panel-win|background-image": "radial-gradient(70% 40% at 50% 0%, rgba(255, 120, 40, 0.07), rgba(0, 0, 0, 0) 70%), linear-gradient(rgb(23, 16, 12), rgb(13, 9, 7))", "#panel-win|border-top-color": "rgb(94, 67, 41)", "#panel-head|height": "50px", "#panel-head|padding-left": "20px", "#panel-head|padding-right": "14px", "#panel-head|background-image": "linear-gradient(rgba(48, 32, 20, 0.6), rgba(18, 12, 9, 0.2))", "#panel-head|border-bottom-color": "rgb(94, 67, 41)", ".brand|width": "150px", ".brand|font-size": "22px", ".brand|letter-spacing": "8px", ".brand|color": "rgb(242, 223, 184)", ".brand|font-family": "\"Songti SC\", STSong, \"Noto Serif SC\", serif", ".tab|font-size": "17px", ".tab|letter-spacing": "4px", ".tab|padding-left": "24px", ".tab|padding-right": "24px", ".tab|color": "rgb(255, 226, 176)", ".tab|font-family": "\"Songti SC\", STSong, \"Noto Serif SC\", serif", ".tab|font-weight": "700", ".tab.on|color": "rgb(255, 226, 176)", ".tab.on|text-shadow": "rgba(255, 130, 50, 0.55) 0px 0px 14px", ".tab kbd|font-size": "11px", ".tab kbd|opacity": "1", "#panel-close|width": "150px", "#panel-close|font-size": "12.5px", "#panel-close|color": "rgb(154, 139, 118)", "#panel-body|padding-top": "14px", "#panel-body|padding-left": "18px", "#panel-body|padding-bottom": "16px", ".sec-title|height": "26px", ".sec-title|font-size": "15.5px", ".sec-title|letter-spacing": "3px", ".sec-title|color": "rgb(230, 197, 138)", ".sec-title|font-family": "\"Songti SC\", STSong, \"Noto Serif SC\", serif", ".sec-title|margin-bottom": "8px", ".sec-note|font-size": "12px", ".sec-note|color": "rgb(154, 139, 118)", ".eq-grid|width": "300px", ".eq-grid|column-gap": "6px", ".eq|width": "70.5px", ".eq|height": "74.7px", ".eq|border-top-color": "rgb(93, 87, 76)", ".eq|border-radius": "3px", ".eq|background-image": "radial-gradient(circle at 50% 30%, rgb(30, 23, 18), rgb(14, 10, 8) 80%)", ".eq-name|font-size": "11px", ".eq-name|color": "rgb(140, 127, 109)", ".bag .cell|width": "67.5px", ".bag .cell|height": "67.5px", ".bag .cell|border-radius": "3px", ".bag .cell|box-shadow": "rgba(0, 0, 0, 0.7) 0px 0px 12px 0px inset", ".bag|column-gap": "6px", ".bag|row-gap": "6px", ".c-ilvl|font-size": "11px", ".c-ilvl|color": "rgb(169, 154, 130)", ".cur|height": "64px", ".cur|width": "67.5px", ".cur|font-size": "11.5px", ".cur|border-top-color": "rgb(46, 34, 25)", ".cur|background-color": "rgb(16, 11, 8)", ".cur b|font-size": "12.5px", ".btn.sm|height": "24px", ".btn.sm|font-size": "12px", ".btn.sm|padding-left": "10px", ".btn.sm|letter-spacing": "1px", ".inv-tips|font-size": "11.5px", ".inv-tips|padding-top": "10px", ".inv-tips|border-top-color": "rgb(36, 26, 19)", "char .st-row|font-size": "12.5px", "char .st-row|line-height": "23px", "char .st-row|color": "rgb(169, 154, 130)", "char .st-row|letter-spacing": "normal", "char .st-row b|font-size": "12.5px", "char .st-row b|line-height": "23px", "char .st-row b|color": "rgb(255, 138, 122)", "char .st-row b|letter-spacing": "normal", "char .st-group|font-size": "11.5px", "char .st-group|line-height": "normal", "char .st-group|color": "rgb(176, 134, 80)", "char .st-group|letter-spacing": "4px"};
// 在页面里跑：按 spec 读计算样式，宽高用 getBoundingClientRect（保留一位小数）
export function uiStyleRead(spec) {
  const r = {};
  for (const key in spec) {
    const sel = key.replace(/^(char|map|helpf|help|set) /, ''); // 前缀只是说在哪一页量（B1 的 char、B4a 的 map / help / set）
    const e = document.querySelector('#panel ' + sel) || document.querySelector(sel);
    for (const p of spec[key]) {
      if (!e) {
        r[key + '|' + p] = null;
        continue;
      }
      r[key + '|' + p] = p === 'width' || p === 'height' ? Math.round(e.getBoundingClientRect()[p] * 10) / 10 + 'px' : getComputedStyle(e).getPropertyValue(p);
    }
  }
  return r;
}

// 桌面样式不变（UI-R B4a）：1366×768 下地图、帮助、设置的关键元素和 main（4484d08）逐项相等。前缀说明在哪一页量（map / help 是页签，set 是暂停菜单 → 设置）。
// 有意改动的不在表里：地图拿掉了底部的设置条，区域卡片更高（.zone 的高度、.z-art 的最小高度）；渊印图例挪进 [?]；帮助页从三列改成话题 + 一节；设置分组、两列、卡片放宽
export const DESK_STYLE_B4A_SPEC = {
  'map .map .sec-title': ['height', 'font-size', 'letter-spacing', 'color', 'font-family'],
  'map .tier': ['width', 'height', 'font-size', 'color', 'background-color', 'border-top-color'],
  'map .tier.on': ['color', 'background-image'],
  'map .zone': ['width', 'border-top-color', 'background-image', 'border-radius'],
  'map .z-glyph': ['font-size', 'color'],
  'map .z-ord': ['font-size', 'letter-spacing'],
  'map .z-badge': ['font-size', 'line-height'],
  'map .z-name': ['font-size', 'letter-spacing', 'color', 'font-family'],
  'map .z-meta': ['font-size', 'color'],
  'map .z-desc': ['font-size', 'line-height', 'color'],
  'map .z-boss': ['font-size'],
  'map .z-body .btn': ['height', 'font-size'],
  'map .tier-note': ['font-size', 'color'],
  'helpf .help p': ['font-size', 'line-height', 'color'], // helpf：在「战斗」这一节量（「操作」里没有段落）
  'help .help .sec-title': ['font-size', 'letter-spacing', 'color'],
  'help .hk': ['font-size', 'min-height', 'color'],
  'help .hk kbd': ['font-size'],
  'help .help-foot': ['font-size', 'color'],
  'set #pause .m-head b': ['font-size', 'letter-spacing', 'color'],
  'set #pause .m-row': ['padding-top', 'padding-bottom', 'border-bottom-style'],
  'set #pause .opt-text b': ['font-size', 'color', 'letter-spacing', 'font-weight'],
  'set #pause .opt-text span': ['font-size', 'color'],
  'set #pause .seg-b': ['height', 'font-size', 'padding-left', 'color'],
  'set #pause .seg-b.on': ['color', 'background-image'],
  'set #pause .switch': ['width', 'height', 'border-radius'],
  'set #pause .vol input': ['width', 'height'],
  'set #pause .m-note': ['font-size', 'color'],
};
export const DESK_STYLE_B4A_MAIN = {"map .map .sec-title|height": "26px", "map .map .sec-title|font-size": "15.5px", "map .map .sec-title|letter-spacing": "3px", "map .map .sec-title|color": "rgb(230, 197, 138)", "map .map .sec-title|font-family": "\"Songti SC\", STSong, \"Noto Serif SC\", serif", "map .tier|width": "34px", "map .tier|height": "30px", "map .tier|font-size": "14px", "map .tier|color": "rgb(255, 243, 220)", "map .tier|background-color": "rgba(0, 0, 0, 0)", "map .tier|border-top-color": "rgb(255, 176, 102)", "map .tier.on|color": "rgb(255, 243, 220)", "map .tier.on|background-image": "linear-gradient(rgb(180, 85, 28), rgb(111, 44, 11))", "map .zone|width": "238.8px", "map .zone|border-top-color": "rgb(176, 134, 80)", "map .zone|background-image": "linear-gradient(rgb(23, 16, 12), rgb(14, 10, 8))", "map .zone|border-radius": "3px", "map .z-glyph|font-size": "70px", "map .z-glyph|color": "color(srgb 1 0.579294 0.398588)", "map .z-ord|font-size": "11.5px", "map .z-ord|letter-spacing": "3px", "map .z-badge|font-size": "11.5px", "map .z-badge|line-height": "20px", "map .z-name|font-size": "18px", "map .z-name|letter-spacing": "3px", "map .z-name|color": "rgb(242, 223, 184)", "map .z-name|font-family": "\"Songti SC\", STSong, \"Noto Serif SC\", serif", "map .z-meta|font-size": "12px", "map .z-meta|color": "rgb(154, 139, 118)", "map .z-desc|font-size": "12px", "map .z-desc|line-height": "19px", "map .z-desc|color": "rgb(185, 172, 150)", "map .z-boss|font-size": "12px", "map .z-body .btn|height": "34px", "map .z-body .btn|font-size": "13px", "map .tier-note|font-size": "12.5px", "map .tier-note|color": "rgb(154, 139, 118)", "help .help .sec-title|font-size": "15.5px", "help .help .sec-title|letter-spacing": "3px", "help .help .sec-title|color": "rgb(230, 197, 138)", "help .hk|font-size": "13px", "help .hk|min-height": "30px", "help .hk|color": "rgb(196, 184, 163)", "help .hk kbd|font-size": "11.5px", "help .help-foot|font-size": "12px", "help .help-foot|color": "rgb(109, 97, 82)", "helpf .help p|font-size": "13px", "helpf .help p|line-height": "21px", "helpf .help p|color": "rgb(196, 184, 163)", "set #pause .m-head b|font-size": "17px", "set #pause .m-head b|letter-spacing": "4px", "set #pause .m-head b|color": "rgb(230, 197, 138)", "set #pause .m-row|padding-top": "10px", "set #pause .m-row|padding-bottom": "10px", "set #pause .m-row|border-bottom-style": "dotted", "set #pause .opt-text b|font-size": "13px", "set #pause .opt-text b|color": "rgb(230, 215, 189)", "set #pause .opt-text b|letter-spacing": "1px", "set #pause .opt-text b|font-weight": "600", "set #pause .opt-text span|font-size": "11.5px", "set #pause .opt-text span|color": "rgb(109, 97, 82)", "set #pause .seg-b|height": "30px", "set #pause .seg-b|font-size": "12.5px", "set #pause .seg-b|padding-left": "14px", "set #pause .seg-b|color": "rgb(154, 139, 118)", "set #pause .seg-b.on|color": "rgb(255, 243, 220)", "set #pause .seg-b.on|background-image": "linear-gradient(rgb(180, 85, 28), rgb(111, 44, 11))", "set #pause .switch|width": "42px", "set #pause .switch|height": "22px", "set #pause .switch|border-radius": "11px", "set #pause .vol input|width": "150px", "set #pause .vol input|height": "22px", "set #pause .m-note|font-size": "12px", "set #pause .m-note|color": "rgb(109, 97, 82)"};
