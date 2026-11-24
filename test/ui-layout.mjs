// 面板布局检查（UI-R，B1 搭框架，B2–B4 往里加面板）。uiLayoutCheck 在页面里跑（page.evaluate），返回不合格项的列表。
// 规则见 docs/ui.md「测试」：
//   a. 文字和点按目标都在视口里；只有 [data-list] 区域里、滚得到的才算例外
//   b. 面板里只有 [data-list] 能纵向溢出（#panel-win、#panel-body、各栏 scrollHeight == clientHeight）
//   c. 页面没有横向溢出
//   d. 触屏：页头 ≤ 36 px；字号 ≥ 11 px；button / [data-act] / .cell / .tab 的盒子 ≥ 44×44（桌面只查字号）
//   e. elementFromPoint 打到每个点按目标的中心，打到的是它自己（或它里面的东西）
//   f. 卡片 / 弹出菜单打开时，里面的操作条整个在视口里（「点外面关掉」由调用方去点）
// opts：{ touch: bool, roots: '#panel-win, …'（默认 #panel-win 和面板里的浮层）, max: 每类最多列几条 }
export function uiLayoutCheck(opts) {
  const o = Object.assign({ touch: false, roots: '#panel-win, #panel .sheet, #panel .ui-pop, #confirm.on', max: 6 }, opts || {});
  const vw = innerWidth, vh = innerHeight;
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
      const r = e.getBoundingClientRect();
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
        const pr = p.getBoundingClientRect();
        if (p.hasAttribute('data-list') && !inList) inList = p;
        clip = { l: Math.max(clip.l, pr.left), t: Math.max(clip.t, pr.top), r: Math.min(clip.r, pr.right), b: Math.min(clip.b, pr.bottom) };
      }
      const outVp = r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1;
      const outClip = r.left < clip.l - 1 || r.top < clip.t - 1 || r.right > clip.r + 1 || r.bottom > clip.b + 1;
      if (outVp || outClip) {
        // data-list 里：滚过去就看得见（列表本身在视口里、元素宽度放得下）
        const lr = inList && inList.getBoundingClientRect();
        const reach = inList && lr.top >= -1 && lr.bottom <= vh + 1 && r.left >= lr.left - 1 && r.right <= lr.right + 1;
        if (!reach) out.a.push(nm(e) + ' ' + R(r) + (outVp ? ' 视口外' : ' 被裁'));
        continue;
      }
      if (isT) targets.push(e);
    }
  }
  // c：横向溢出
  if (document.documentElement.scrollWidth > vw + 0.5) out.c.push('页面横向 ' + document.documentElement.scrollWidth + ' > ' + vw);
  // d：页头、点按区
  if (o.touch) {
    const head = document.getElementById('panel-head');
    if (head && vis(head) && head.getBoundingClientRect().height > 36.5) out.d.push('页头 ' + Math.round(head.getBoundingClientRect().height) + ' px');
    for (const e of targets) {
      const r = e.getBoundingClientRect();
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
  // f：卡片 / 弹出菜单的操作条在视口里
  for (const bar of document.querySelectorAll('#panel .sheet .sh-acts, #panel .ui-pop')) {
    if (!vis(bar)) continue;
    const r = bar.getBoundingClientRect();
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

// 每个尺寸：[宽, 高, 触屏?, 安全区 px]。触屏横屏各跑一组 59 px 安全区（iOS 横屏刘海）和一组 0；竖屏的安全区在上下，不加左右
export const UI_SIZES = [
  [844, 340, true, 0], [844, 340, true, 59],
  [667, 320, true, 0], [667, 320, true, 59],
  [734, 338, true, 0], [734, 338, true, 59],
  [1000, 450, true, 0], [1000, 450, true, 59],
  [390, 844, true, 0], [390, 844, true, 59],
  [1920, 1080, false, 0], [1366, 768, false, 0], [1280, 720, false, 0],
];
