// 圆角遮罩检查（mobile-hotfix）：iPhone 屏幕四角是圆的（半径约 47 px），落在圆角外面的字和按钮会被切掉。
// 在页面里量：每个角的 R×R 方块里、离圆心 (R, R) 超过 R 的那一块就是遮罩；看得见的可点元素（按圆角后的外形）和每一行字都不许碰它。
// 两个函数都要传给 page.evaluate（在页面里跑，不能引用外面的变量）：
//   cornerCheck({ R, sel, boxes })：返回 { W, H, n, hits: [{ what, corner, box }] }
//   cornerDraw({ R, hits })：在页面上盖一层，画出四角的遮罩和撞上的元素（截图用；再调一次 cornerDraw(null) 去掉）

export function cornerCheck(o) {
  const R = (o && o.R) || 47;
  const W = window.innerWidth, H = window.innerHeight;
  const EPS = 0.5;
  // 可点的东西：按钮、链接、表单、触屏键（data-tb / data-tt）、菜单项（data-tact）、技能格、摇杆区、职业卡
  const SEL = (o && o.sel) || 'button, a[href], input, select, textarea, [data-tb], [data-tt], [data-tact], .slot, #t-stick, .cl-card, [role=button]';
  // 贴边的 HUD 框（不可点也不能被圆角切掉一块）：生命 / 法力条、区域名、追踪、提示卡、旁白卡、首领条、药瓶、F 键、连击、拾取记录
  const BOX = (o && o.boxes) || '.t-bar, #zone-box, #quest, #coach, #narr, #boss-box, .flask, #t-f, #combo, #feed';
  const cs = (n) => getComputedStyle(n);
  // 看得见：有盒子、没有 visibility:hidden、一路往上的不透明度乘起来 > 0.05、不在 #t-safe 这种探针里
  const visible = (n) => {
    if (!n.getClientRects().length) return false;
    const s = cs(n);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    let op = 1;
    for (let e = n; e && e.nodeType === 1; e = e.parentElement) {
      op *= parseFloat(cs(e).opacity);
      if (op < 0.05) return false;
    }
    return true;
  };
  // 祖先的 overflow 裁剪 + 视口：返回看得见的那一块（null = 全被裁掉）
  const clipOf = (n) => {
    let c = { l: 0, t: 0, r: W, b: H };
    for (let e = n.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const s = cs(e);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const b = e.getBoundingClientRect();
        if (s.overflowX !== 'visible') c = { l: Math.max(c.l, b.left), t: c.t, r: Math.min(c.r, b.right), b: c.b };
        if (s.overflowY !== 'visible') c = { l: c.l, t: Math.max(c.t, b.top), r: c.r, b: Math.min(c.b, b.bottom) };
      }
      if (s.position === 'fixed') break;
    }
    return c;
  };
  // 一个（圆角）矩形撞不撞某个角的遮罩：把它换到以这个角为原点的坐标，取朝着角的那个圆角弧上的点，
  // 只要有一点落在 R×R 方块里、离 (R, R) 又超过 R，就算撞上
  const corners = [
    ['左上', (x) => x, (y) => y, 'TopLeft'],
    ['右上', (x) => W - x, (y) => y, 'TopRight'],
    ['左下', (x) => x, (y) => H - y, 'BottomLeft'],
    ['右下', (x) => W - x, (y) => H - y, 'BottomRight'],
  ];
  const hitsMask = (box, rad) => {
    const out = [];
    for (const [name, fx, fy, key] of corners) {
      // 这个角方向上最靠角的那个顶点（换成角坐标）
      const a = Math.min(fx(box.l), fx(box.r)), b = Math.min(fy(box.t), fy(box.b));
      if (a >= R - EPS || b >= R - EPS) continue;
      const w = box.r - box.l, h = box.b - box.t;
      const rr = Math.max(0, Math.min((rad && rad[key]) || 0, w / 2, h / 2));
      let hit = false;
      for (let i = 0; i <= 24 && !hit; i++) {
        const th = (Math.PI / 2) * (i / 24);
        const x = a + rr - rr * Math.cos(th), y = b + rr - rr * Math.sin(th);
        if (x < R && y < R && Math.hypot(R - x, R - y) > R + EPS) hit = true;
      }
      if (hit) out.push(name);
    }
    return out;
  };
  const rd = (b) => [b.l, b.t, b.r, b.b].map((v) => Math.round(v)).join(',');
  const label = (n) => {
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    else {
      for (const a of ['data-tb', 'data-tt', 'data-tact']) if (n.getAttribute(a)) s += '[' + a + '=' + n.getAttribute(a) + ']';
      if (n.classList.length) s += '.' + Array.from(n.classList).slice(0, 2).join('.');
      let p = n.parentElement;
      while (p && !p.id) p = p.parentElement;
      if (p) s = '#' + p.id + ' ' + s;
    }
    return s;
  };
  const hits = [];
  let n = 0;
  // 1) 可点的元素和贴边的 HUD 框：按圆角后的外形量（圆按钮的方框角不算），被祖先裁掉的边按直边算
  const els = new Set();
  for (const el of document.querySelectorAll(SEL)) if (cs(el).pointerEvents !== 'none') els.add(el);
  for (const el of document.querySelectorAll(BOX)) els.add(el);
  for (const el of els) {
    if (!visible(el)) continue;
    const b0 = el.getBoundingClientRect();
    const c = clipOf(el);
    const box = { l: Math.max(b0.left, c.l), t: Math.max(b0.top, c.t), r: Math.min(b0.right, c.r), b: Math.min(b0.bottom, c.b) };
    if (box.r - box.l < 1 || box.b - box.t < 1) continue;
    const s = cs(el);
    const px = (v) => parseFloat(v) || 0;
    // 旋转横屏（手机版 M2，html.t-rot）：元素自己的四个圆角转过去以后落在屏幕的另一个角上（屏幕的哪个角 ← 元素的哪个角）
    const ROTK = !(window.G && G.rot) ? null : G.rot.dir === 'cw' ? { TopLeft: 'BottomLeft', TopRight: 'TopLeft', BottomRight: 'TopRight', BottomLeft: 'BottomRight' } : { TopLeft: 'TopRight', TopRight: 'BottomRight', BottomRight: 'BottomLeft', BottomLeft: 'TopLeft' };
    const radOf = (k) => px(s['border' + (ROTK ? ROTK[k] : k) + 'Radius']);
    const rad = {
      TopLeft: box.l === b0.left && box.t === b0.top ? radOf('TopLeft') : 0,
      TopRight: box.r === b0.right && box.t === b0.top ? radOf('TopRight') : 0,
      BottomLeft: box.l === b0.left && box.b === b0.bottom ? radOf('BottomLeft') : 0,
      BottomRight: box.r === b0.right && box.b === b0.bottom ? radOf('BottomRight') : 0,
    };
    n++;
    for (const k of hitsMask(box, rad)) hits.push({ what: label(el), corner: k, box: rd(box) });
  }
  // 2) 每一行字（文字节点的行框）
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const seen = new Map();
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    if (!t.textContent.trim()) continue;
    const p = t.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    let ok = seen.get(p);
    if (ok === undefined) seen.set(p, (ok = visible(p) ? clipOf(p) : null));
    if (!ok) continue;
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      const box = { l: Math.max(r.left, ok.l), t: Math.max(r.top, ok.t), r: Math.min(r.right, ok.r), b: Math.min(r.bottom, ok.b) };
      if (box.r - box.l < 1 || box.b - box.t < 1) continue;
      n++;
      for (const k of hitsMask(box, null)) hits.push({ what: '字「' + t.textContent.trim().slice(0, 12) + '」(' + label(p) + ')', corner: k, box: rd(box) });
    }
  }
  // 3) 小地图（画在 2D 画布上，没有元素）
  const mm = window.G && G.world && G.world.mmTouch;
  if (mm && document.documentElement.classList.contains('touch-ui') && !document.documentElement.classList.contains('t-portrait') && !(G.ui.titleOn && G.ui.titleOn())) {
    // W.mmTouch 是画面坐标：旋转横屏时换回屏幕坐标再量
    const p1 = G.toScreen ? G.toScreen(mm.x, mm.y) : { x: mm.x, y: mm.y }, p2 = G.toScreen ? G.toScreen(mm.x + 110, mm.y + 110) : { x: mm.x + 110, y: mm.y + 110 };
    const box = { l: Math.min(p1.x, p2.x), t: Math.min(p1.y, p2.y), r: Math.max(p1.x, p2.x), b: Math.max(p1.y, p2.y) };
    n++;
    for (const k of hitsMask(box, null)) hits.push({ what: '小地图', corner: k, box: rd(box) });
  }
  return { W, H, n, hits };
}

export function cornerDraw(o) {
  const old = document.getElementById('__cmask');
  if (old) old.remove();
  if (!o) return;
  const R = o.R || 47, W = window.innerWidth, H = window.innerHeight;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = '__cmask';
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';
  // 四角的遮罩：方块减去四分之一圆
  const d =
    'M0,0 H' + R + ' A' + R + ',' + R + ' 0 0 0 0,' + R + ' Z ' +
    'M' + W + ',0 V' + R + ' A' + R + ',' + R + ' 0 0 0 ' + (W - R) + ',0 Z ' +
    'M0,' + H + ' V' + (H - R) + ' A' + R + ',' + R + ' 0 0 0 ' + R + ',' + H + ' Z ' +
    'M' + W + ',' + H + ' H' + (W - R) + ' A' + R + ',' + R + ' 0 0 0 ' + W + ',' + (H - R) + ' Z';
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'rgba(255,0,200,0.55)');
  svg.appendChild(p);
  for (const h of o.hits || []) {
    const [l, t, r, b] = h.box.split(',').map(Number);
    const q = document.createElementNS(ns, 'rect');
    q.setAttribute('x', l);
    q.setAttribute('y', t);
    q.setAttribute('width', Math.max(1, r - l));
    q.setAttribute('height', Math.max(1, b - t));
    q.setAttribute('fill', 'none');
    q.setAttribute('stroke', '#00ffff');
    q.setAttribute('stroke-width', '2');
    svg.appendChild(q);
  }
  document.body.appendChild(svg);
}

// 在 Node 这边把各个画面走一遍、逐个量（test/smoke.mjs 的 CDP 手机模拟和 test/webkit-smoke.mjs 共用）。
// 进来时 page 停在标题画面（title: true、新的浏览器配置，「继续游戏」可点）；sizes：[[宽, 高], …]，[null] = 不改窗口大小。
// 量的画面：标题、职业选择（顶上和滚到底的「以 X 开始」）、开场故事、游戏 HUD（提示卡、旁白卡、首领条、F 键都打开）、背包、技能、暂停菜单、开场卡片。
// 返回 { lines: ['844×390 hud 41 个', …], bad: ['844×390 hud：右下 …', …] }
export async function cornerScenes(page, sizes, o) {
  const R = (o && o.R) || 47;
  const ev = (f, a) => page.evaluate(f, a);
  const lines = [], bad = [];
  // 入场动画（面板往上 8 px、卡片淡入）放完再量；一直循环的动画不等
  const settle = async () => {
    await page.waitForTimeout(120);
    await ev(() =>
      Promise.race([
        Promise.all(document.getAnimations().filter((a) => a.effect && isFinite(a.effect.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 3000)),
      ])
    );
    await page.waitForTimeout(80);
  };
  const size = async (sz) => {
    if (sz) await page.setViewportSize({ width: sz[0], height: sz[1] });
    await page.waitForTimeout(150);
    await ev(() => window.dispatchEvent(new Event('resize')));
    await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const check = async (tag) => {
    await settle();
    const r = await ev(cornerCheck, { R });
    lines.push(r.W + '×' + r.H + ' ' + tag + ' ' + r.n);
    if (r.hits.length) bad.push(r.W + '×' + r.H + ' ' + tag + '：' + r.hits.map((h) => h.corner + ' ' + h.what + ' [' + h.box + ']').join(' | '));
  };
  for (const sz of sizes) {
    await size(sz);
    await check('标题');
    await ev(() => document.getElementById('t-new').click());
    await page.waitForFunction(() => G.ui.classView && G.ui.classView(), null, { timeout: 30000 });
    await check('职业选择');
    await ev(() => {
      const v = document.querySelector('#title .m-body');
      if (v) v.scrollTop = 1e5;
    });
    await check('职业选择底栏');
    await ev(() => document.querySelector('#title [data-tact="back"]').click());
    await page.waitForTimeout(200);
  }
  await ev(() => document.getElementById('t-continue').click());
  await page.waitForFunction(() => !G.ui.titleOn() && G.state && G.state.zone, null, { timeout: 60000 });
  // 新的浏览器配置：第一次进游戏放开场故事（有的话），每个尺寸量一次再跳过
  await page.waitForFunction(() => G.ui.storyOn() || document.getElementById('intro').classList.contains('on'), null, { timeout: 30000 }).catch(() => {});
  if (await ev(() => G.ui.storyOn())) {
    await page.waitForFunction(() => document.querySelector('#story.ready'), null, { timeout: 30000 }).catch(() => {});
    for (const sz of sizes) {
      await size(sz);
      await check('开场故事');
    }
    await ev(() => document.querySelector('#story .st-skip').click());
    await page.waitForFunction(() => !G.ui.storyOn(), null, { timeout: 10000 });
  }
  await ev(() => {
    try {
      localStorage.setItem('cinder-abyss-touch-hint', '1');
    } catch (e) {}
    G.save.seenHelp = G.save.seenStory = true;
    for (const id of G.ui.hints().all) G.save.tut[id] = 1;
    G.ui.close();
    G.debug.god(true);
    G.debug.hold(true);
  });
  for (const sz of sizes) {
    await size(sz);
    await ev(() => {
      document.getElementById('boss-box').classList.add('on');
      document.getElementById('t-f').classList.add('on');
      const co = document.getElementById('coach');
      co.querySelector('.co-body').innerHTML = '按住右下的<b>大按钮</b>施放「掷焰」，旁边的是武器普攻「疾咒」。会自动瞄准，从按钮拖出去可以手动瞄，拖回按钮上取消，松手就放出';
      co.className = 'on';
      const n = document.getElementById('narr');
      n.children[0].textContent = '灰烬底下还有火。';
      n.children[1].textContent = '沿着路往前走，别回头。';
      n.classList.add('show', 'on', 'l2');
    });
    await check('HUD');
    await ev(() => {
      document.getElementById('boss-box').classList.remove('on');
      document.getElementById('t-f').classList.remove('on');
      document.getElementById('coach').className = '';
      document.getElementById('narr').classList.remove('show', 'on', 'l2');
      G.ui.open('inv');
    });
    await check('背包');
    await ev(() => {
      G.ui.close();
      G.ui.open('skills');
    });
    await check('技能');
    await ev(() => {
      G.ui.close();
      G.ui.pause();
    });
    await check('暂停菜单');
    await ev(() => {
      G.ui.close();
      G.ui.showIntro();
    });
    await check('开场卡片');
    await ev(() => G.ui.close());
  }
  return { lines, bad };
}

// 手机版 M2：按钮大小、左手模式、旋转横屏下 HUD 和背包也不碰圆角。configs：[[宽, 高, 按钮大小 's'|'m'|'l', 左手模式, 旋转 null|'cw'|'ccw'], ...]
// 量的是屏幕坐标：旋转横屏时屏幕的四个圆角还在原地，转过去的画面的四角正好落在那里。调用前要已经在游戏里（标题、故事、卡片都收起）
export async function cornerHud(page, configs, o) {
  const R = (o && o.R) || 47;
  const ev = (f, a) => page.evaluate(f, a);
  const lines = [], bad = [];
  const settle = async () => {
    await page.waitForTimeout(120);
    await ev(() =>
      Promise.race([
        Promise.all(document.getAnimations().filter((a) => a.effect && isFinite(a.effect.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 3000)),
      ])
    );
    await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const check = async (tag) => {
    await settle();
    const r = await ev(cornerCheck, { R });
    lines.push(r.W + '×' + r.H + ' ' + tag + ' ' + r.n);
    if (r.hits.length) bad.push(r.W + '×' + r.H + ' ' + tag + '：' + r.hits.map((h) => h.corner + ' ' + h.what + ' [' + h.box + ']').join(' | '));
  };
  for (const [w, h, size, mirror, rot] of configs) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    await ev(([size, mirror, rot]) => {
      G.touch.setRot(rot || null);
      G.touch.setPref('size', size || 'm');
      G.touch.setPref('mirror', !!mirror);
      window.dispatchEvent(new Event('resize'));
      document.getElementById('boss-box').classList.add('on');
      document.getElementById('t-f').classList.add('on');
      const co = document.getElementById('coach');
      co.querySelector('.co-body').innerHTML = '按住右下的<b>大按钮</b>施放「掷焰」，旁边的是武器普攻「疾咒」。会自动瞄准，从按钮拖出去可以手动瞄，拖回按钮上取消，松手就放出';
      co.className = 'on';
    }, [size, mirror, rot]);
    const tag = '（' + (size || 'm') + (mirror ? ' 左手' : '') + (rot ? ' 旋转' + rot : '') + '）';
    await check('HUD' + tag);
    await ev(() => {
      document.getElementById('boss-box').classList.remove('on');
      document.getElementById('t-f').classList.remove('on');
      document.getElementById('coach').className = '';
      if (G.rot) G.ui.open('inv');
    });
    if (rot) {
      await check('背包' + tag);
      await ev(() => G.ui.close());
    }
  }
  await ev(() => {
    G.touch.setRot(null);
    G.touch.setPref('size', 'm');
    G.touch.setPref('mirror', false);
  });
  return { lines, bad };
}
