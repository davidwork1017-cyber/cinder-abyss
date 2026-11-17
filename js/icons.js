'use strict';
// 图标：全部用 canvas 现画，缓存成 data URL，并按需注册成 CSS 类（.ico-<key>）。
// 画法统一：左上来光、深色描边、两段明暗 + 内侧倒角、发光件单独叠一层，
// 所以装备 / 通货 / 技能 / 辅助宝石放在一起是同一套东西。
(function () {
  const G = window.G;
  const PX = 128; // 画布边长；界面里按 20–64 CSS 像素显示，2 倍屏也不糊
  const U = PX / 64; // 逻辑坐标：以图标中心为原点，范围约 ±30
  const TAU = Math.PI * 2;
  const INK = '#150d09';

  // ---------- 颜色 ----------
  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    const x = rgb(a), y = rgb(b);
    const f = (i) => Math.round(x[i] + (y[i] - x[i]) * t).toString(16).padStart(2, '0');
    return '#' + f(0) + f(1) + f(2);
  }
  const lite = (c, t) => mix(c, '#ffffff', t);
  const dark = (c, t) => mix(c, '#000000', t);
  function rgba(hex, a) {
    const c = rgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  // ---------- 画笔：带仿射变换与轻微手抖的路径 ----------
  // m = [a, b, c, d, e, f]：X = a·x + c·y + e，Y = b·x + d·y + f
  function rot(deg, s, tx, ty) {
    const r = (deg * Math.PI) / 180, k = s || 1;
    const c = Math.cos(r) * k, n = Math.sin(r) * k;
    return [c, n, -n, c, tx || 0, ty || 0];
  }
  const ID = [1, 0, 0, 1, 0, 0];
  const frac = (v) => v - Math.floor(v);
  function pen(g, m, amp, seed) {
    m = m || ID;
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
    const sc = Math.sqrt(Math.abs(a * d - b * c));
    const ang = Math.atan2(b, a);
    const jit = (x, y, k) => (amp ? (frac(Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719 + k * 4.13) * 43758.5453) - 0.5) * 2 * amp : 0);
    const X = (x, y) => a * x + c * y + e + jit(x, y, 0);
    const Y = (x, y) => b * x + d * y + f + jit(x, y, 1);
    const p = {
      M(x, y) { g.moveTo(X(x, y), Y(x, y)); return p; },
      L(x, y) { g.lineTo(X(x, y), Y(x, y)); return p; },
      Q(cx, cy, x, y) { g.quadraticCurveTo(X(cx, cy), Y(cx, cy), X(x, y), Y(x, y)); return p; },
      C(ax, ay, bx, by, x, y) { g.bezierCurveTo(X(ax, ay), Y(ax, ay), X(bx, by), Y(bx, by), X(x, y), Y(x, y)); return p; },
      Z() { g.closePath(); return p; },
      // 椭圆 / 圆（不抖，否则接不上头）
      E(x, y, rx, ry) {
        const cx = a * x + c * y + e, cy = b * x + d * y + f;
        g.moveTo(cx + Math.cos(ang) * rx * sc, cy + Math.sin(ang) * rx * sc);
        g.ellipse(cx, cy, rx * sc, (ry === undefined ? rx : ry) * sc, ang, 0, TAU);
        g.closePath();
        return p;
      },
      // 多边形：[x0, y0, x1, y1, ...]
      P(arr) {
        p.M(arr[0], arr[1]);
        for (let i = 2; i < arr.length; i += 2) p.L(arr[i], arr[i + 1]);
        return p.Z();
      },
      // 圆角矩形
      R(x, y, w, h, r) {
        r = Math.min(r || 0, w / 2, h / 2);
        return p.M(x + r, y).L(x + w - r, y).Q(x + w, y, x + w, y + r).L(x + w, y + h - r).Q(x + w, y + h, x + w - r, y + h)
          .L(x + r, y + h).Q(x, y + h, x, y + h - r).L(x, y + r).Q(x, y, x + r, y).Z();
      },
    };
    return p;
  }

  // 实心件：渐变底色 → 内侧倒角（左上亮、右下暗）→ 深色描边
  function solid(g, trace, col, o) {
    o = o || {};
    const m = o.m, rule = o.rule || 'nonzero';
    g.save();
    g.beginPath();
    trace(pen(g, m));
    const gr = g.createLinearGradient(-18, -22, 16, 24);
    gr.addColorStop(0, lite(col, o.hi === undefined ? 0.3 : o.hi));
    gr.addColorStop(0.5, col);
    gr.addColorStop(1, dark(col, o.lo === undefined ? 0.45 : o.lo));
    g.fillStyle = gr;
    g.fill(rule);
    if (o.bevel !== 0) {
      g.clip(rule);
      const w = o.bevel || 2;
      g.lineWidth = w;
      g.strokeStyle = 'rgba(0,0,0,0.34)';
      g.translate(-w * 0.62, -w * 0.62);
      g.beginPath();
      trace(pen(g, m));
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,' + (o.shine === undefined ? 0.4 : o.shine) + ')';
      g.translate(w * 1.24, w * 1.24);
      g.beginPath();
      trace(pen(g, m));
      g.stroke();
    }
    g.restore();
    if (o.lw !== 0) {
      g.beginPath();
      trace(pen(g, m, 0.28, 3));
      g.lineWidth = o.lw || 2.3;
      g.strokeStyle = o.ink || INK;
      g.stroke();
    }
  }

  // 管状件（杖身、绳、带子、环）：描边 → 本色 → 高光 / 暗部
  function tube(g, trace, col, w, o) {
    o = o || {};
    const m = o.m;
    const run = (lw, style, dx, amp) => {
      g.save();
      if (dx) g.translate(dx, dx);
      g.beginPath();
      trace(pen(g, m, amp || 0, 5));
      g.lineWidth = lw;
      g.strokeStyle = style;
      g.stroke();
      g.restore();
    };
    g.lineCap = o.cap || 'round';
    run(w + 2.6, o.ink || INK, 0, 0.2);
    run(w, col);
    run(w * 0.34, dark(col, 0.38), w * 0.26);
    run(w * 0.3, lite(col, 0.42), -w * 0.24);
    g.lineCap = 'round';
  }

  // 细线：刻痕、缝线、纹路
  function line(g, trace, col, w, m, dash) {
    g.save();
    g.beginPath();
    trace(pen(g, m, 0.15, 9));
    g.lineWidth = w || 1.2;
    g.strokeStyle = col;
    if (dash) g.setLineDash(dash);
    g.stroke();
    g.restore();
  }

  // 发光件：外发光 + 亮芯
  function glow(g, trace, col, o) {
    o = o || {};
    g.save();
    g.shadowColor = col;
    g.shadowBlur = (o.blur === undefined ? 7 : o.blur) * U;
    g.beginPath();
    trace(pen(g, o.m));
    if (o.stroke) {
      g.lineWidth = o.stroke;
      g.strokeStyle = o.core || lite(col, 0.55);
      g.stroke();
      g.stroke();
    } else {
      g.fillStyle = o.core || lite(col, 0.55);
      g.fill();
      g.fill();
    }
    g.restore();
  }

  // 四角星芒
  function spark(g, x, y, r, col) {
    const k = r * 0.2;
    glow(g, (p) => p.P([x, y - r, x + k, y - k, x + r, y, x + k, y + k, x, y + r, x - k, y + k, x - r, y, x - k, y - k]), col, { blur: 4, core: '#ffffff' });
  }

  // 刻面宝石：底色、亮面、暗面、高光点
  function gem(g, x, y, r, col, sides, m, o) {
    o = o || {};
    const n = sides || 6, a0 = o.a0 === undefined ? -Math.PI / 2 : o.a0, ky = o.ky || 1;
    const pt = (i, k) => [x + Math.cos(a0 + (i / n) * TAU) * r * k, y + Math.sin(a0 + (i / n) * TAU) * r * k * ky];
    const ring = (k) => { const a = []; for (let i = 0; i < n; i++) a.push.apply(a, pt(i, k)); return a; };
    if (o.glow !== 0) glow(g, (p) => p.P(ring(1)), col, { m, blur: o.glow || 5, core: col });
    solid(g, (p) => p.P(ring(1)), col, { m, hi: 0.5, lo: 0.5, bevel: 1.4, lw: o.lw || 1.9 });
    g.save();
    g.beginPath();
    pen(g, m).P(ring(0.52));
    g.fillStyle = rgba('#ffffff', 0.3);
    g.fill();
    g.restore();
    line(g, (p) => { for (let i = 0; i < n; i++) { const a = pt(i, 1), b = pt(i, 0.52); p.M(a[0], a[1]).L(b[0], b[1]); } }, rgba('#ffffff', 0.34), 0.8, m);
    g.save();
    g.beginPath();
    pen(g, m).E(x - r * 0.26, y - r * 0.3 * ky, r * 0.17);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fill();
    g.restore();
  }

  // 材质色
  const C = {
    leather: '#a2683c', leatherD: '#74482a', hide: '#c08a54', iron: '#a4adb7', ironD: '#737c88', steel: '#c3ccd6',
    dusk: '#5b5466', duskD: '#3d3846', ember: '#ff8a3c', wood: '#8f6038', woodD: '#69431f', bone: '#e4dac0', boneD: '#b7a885',
    gold: '#e9b949', copper: '#d07a44', silver: '#d2dbe5', stone: '#8f8c88', cloth: '#7d3b2c', cord: '#6a4a30',
    fire: '#ff7a2c', cold: '#86d8ff', light: '#ffe45e', mana: '#6f9dff', blood: '#e2362e', abyss: '#c05cff', leaf: '#7ed67a',
  };
  const ALLY = '#4fe3c8'; // 友方仆从的魂火青色：世界里的血条、地面圈、界面上的仆从条都用这一种

  // =====================================================================
  // 装备
  // =====================================================================
  // 武器 0：刃（铁刃 / 战刃 / 烬钢刃）
  function drawBlade(g, t) {
    const m = rot(45, 1.1, -1.5, 1.5);
    const steel = t === 2 ? '#4b4655' : t === 1 ? C.steel : C.iron;
    const hw = t === 1 ? 4.8 : 3.7;
    if (t === 2) {
      // 波刃
      solid(g, (p) => p.M(-hw, 7).L(-hw - 1.6, 1).L(-hw + 0.6, -5).L(-hw - 1.4, -11).L(-hw + 0.4, -17).L(0, -27).L(hw - 0.4, -17).L(hw + 1.4, -11).L(hw - 0.6, -5).L(hw + 1.6, 1).L(hw, 7).Z(), steel, { m });
      glow(g, (p) => p.M(0, 5).L(0, -20), C.ember, { m, stroke: 1.2, blur: 2.2 });
    } else {
      solid(g, (p) => p.M(-hw, 7).L(-hw, -17).L(0, -27).L(hw, -17).L(hw, 7).Z(), steel, { m });
      line(g, (p) => p.M(0, 5).L(0, -18), dark(steel, 0.42), 1.3, m);
      if (t === 1) line(g, (p) => p.M(-1.7, 4).L(-1.7, -15), rgba('#ffffff', 0.5), 0.8, m);
    }
    // 护手
    const gc = t === 2 ? C.duskD : t === 1 ? C.gold : C.ironD;
    if (t === 0) solid(g, (p) => p.R(-8.5, 7, 17, 3.8, 1.4), gc, { m });
    else if (t === 1) solid(g, (p) => p.M(-11, 6).Q(-9, 9.5, -4, 7.2).L(4, 7.2).Q(9, 9.5, 11, 6).L(11.5, 10).Q(6, 12.5, 4, 11.2).L(-4, 11.2).Q(-6, 12.5, -11.5, 10).Z(), gc, { m });
    else solid(g, (p) => p.P([-12, 5, -5, 7.4, 0, 6, 5, 7.4, 12, 5, 9, 11.5, 0, 12.6, -9, 11.5]), gc, { m });
    // 握柄与配重
    solid(g, (p) => p.R(-2.1, 11, 4.2, 9.5, 1), t === 2 ? '#2e2630' : C.leatherD, { m, bevel: 1.2 });
    line(g, (p) => p.M(-2, 13.5).L(2, 14.6).M(-2, 16.2).L(2, 17.3), rgba('#000000', 0.5), 0.9, m);
    if (t === 2) gem(g, 0, 23, 3.1, C.ember, 4, m);
    else solid(g, (p) => p.E(0, 22.8, t === 1 ? 3.1 : 2.6), gc, { m, bevel: 1.2 });
  }

  // 武器 1：长杖（木杖 / 符文杖 / 渊晶杖）
  function drawStaff(g, t) {
    const m = rot(32, 1, 3, 2);
    const wood = t === 2 ? '#4a3f52' : C.wood;
    tube(g, (p) => p.M(0, 27).Q(t === 0 ? -1.6 : 0, 8, 0, -11), wood, 3.4, { m });
    if (t === 0) {
      // 盘曲的杖头
      tube(g, (p) => p.M(0, -10).C(-1, -22, 10, -25, 11, -17).C(11.5, -11, 4, -10.5, 4.5, -15.5), wood, 3.4, { m });
      solid(g, (p) => p.R(-2.6, 9, 5.2, 5, 1), C.leatherD, { m, bevel: 1 });
      line(g, (p) => p.M(-2.4, 11).L(2.4, 12), rgba('#000000', 0.5), 0.9, m);
    } else if (t === 1) {
      solid(g, (p) => p.R(-2.8, -13, 5.6, 3.6, 1), C.gold, { m, bevel: 1 });
      solid(g, (p) => p.R(-2.6, 8, 5.2, 3.2, 1), C.gold, { m, bevel: 1 });
      tube(g, (p) => p.E(0, -20.5, 7.2), C.gold, 2.6, { m });
      glow(g, (p) => p.P([0, -25.2, 3.2, -20.5, 0, -15.8, -3.2, -20.5]), C.mana, { m, blur: 6, core: lite(C.mana, 0.6) });
      line(g, (p) => p.M(-0.2, 1).L(1.2, -1.2).L(-1, -3).L(0.4, -5.4), lite(C.mana, 0.4), 1, m);
    } else {
      // 三爪托着一块渊晶
      solid(g, (p) => p.M(-2.4, -9).Q(-9, -13, -7.4, -23).L(-4.6, -20).Q(-5, -14, -1, -12.4).L(1, -12.4).Q(5, -14, 4.6, -20).L(7.4, -23).Q(9, -13, 2.4, -9).Z(), C.duskD, { m });
      gem(g, 0, -21, 6, C.abyss, 4, m, { ky: 1.35, glow: 8 });
      solid(g, (p) => p.R(-2.7, 6, 5.4, 3, 1), C.ironD, { m, bevel: 1 });
      glow(g, (p) => p.M(0, 2).L(0, -5), C.abyss, { m, stroke: 1, blur: 3 });
    }
  }

  // 武器 2：短杖（骨杖 / 灵枝 / 雷纹短杖）
  function drawWand(g, t) {
    const m = rot(45, 1.12, -2, 2);
    if (t === 0) {
      tube(g, (p) => p.M(0, 20).L(0, -16), C.bone, 3.6, { m });
      solid(g, (p) => p.E(-2.3, -19, 3.1).E(2.3, -19, 3.1), C.bone, { m, bevel: 1.2 });
      solid(g, (p) => p.E(-2.1, 22, 2.7).E(2.1, 22, 2.7), C.bone, { m, bevel: 1.2 });
      line(g, (p) => p.M(-1.8, 6).L(1.8, 6.8).M(-1.8, 9.4).L(1.8, 10.2).M(-1.8, 12.8).L(1.8, 13.6), dark(C.bone, 0.5), 1, m);
    } else if (t === 1) {
      tube(g, (p) => p.M(0, 22).C(-3, 12, 3, 4, 0, -6).C(-2, -12, 1, -16, 0, -20), C.wood, 3.2, { m });
      tube(g, (p) => p.M(0, 2).Q(4, -1, 7.5, -3.5), C.wood, 1.8, { m });
      solid(g, (p) => p.M(7, -3.5).Q(13.5, -9.5, 15.5, -3).Q(11, 0.5, 7, -3.5).Z(), C.leaf, { m, bevel: 1.1, lw: 1.8 });
      solid(g, (p) => p.M(-1, -9).Q(-9, -11, -9.5, -17.5).Q(-3, -17, -1, -9).Z(), C.leaf, { m, bevel: 1.1, lw: 1.8 });
      glow(g, (p) => p.E(0, -22, 3), C.leaf, { m, blur: 7, core: lite(C.leaf, 0.7) });
    } else {
      tube(g, (p) => p.M(0, 22).L(0, -12), C.ironD, 3.8, { m });
      solid(g, (p) => p.R(-3, 15, 6, 3, 1), C.gold, { m, bevel: 1 });
      solid(g, (p) => p.R(-3, -13, 6, 3, 1), C.gold, { m, bevel: 1 });
      // 叉形杖头夹着电火花
      solid(g, (p) => p.P([-3, -12, -6.5, -22, -4, -22.5, -1.4, -15, 1.4, -15, 4, -22.5, 6.5, -22, 3, -12]), C.ironD, { m, bevel: 1.2 });
      glow(g, (p) => p.M(0, 12).L(1.6, 7).L(-1.4, 3.4).L(1.4, -1).L(-1, -5).L(0.6, -9), C.light, { m, stroke: 1.3, blur: 4 });
      spark(g, 12.2, -17.4, 5.2, C.light);
    }
  }

  // 武器 3：双匕（两柄交叉的短刃；t0 骨匕、t1 鸦喙般的乌钢弯刃配金护手、t2 暗刃烬火刃口）
  function drawDaggers(g, t) {
    const steel = t === 2 ? '#4b4655' : t === 1 ? '#7d8796' : C.bone;
    const one = (m, back) => {
      g.save();
      if (back) g.globalAlpha = 0.92;
      // 刃：t1 / t2 微弯，t2 带一道回钩
      if (t === 0) solid(g, (p) => p.M(-3.2, 5).L(-3.6, -6).Q(-3.4, -15, 0, -22).Q(2.2, -15, 3.6, -6).L(3.2, 5).Z(), steel, { m, hi: 0.4 });
      else if (t === 1) solid(g, (p) => p.M(-3, 5).L(-4.6, -6).Q(-4.4, -17, 2.6, -24).Q(1.6, -21, 2.2, -18).Q(5, -12, 4.4, -5).L(3.2, 5).Z(), steel, { m });
      else solid(g, (p) => p.M(-3, 5).L(-3.4, -6).L(-5.4, -10).L(-3, -12).Q(-1.4, -19, 2.6, -24).Q(4, -14, 3.4, -4).L(3.2, 5).Z(), steel, { m });
      if (t === 2) glow(g, (p) => p.M(3.1, 3).Q(3.6, -12, 2.4, -21), C.ember, { m, stroke: 1.1, blur: 2.4 });
      else if (t === 0) line(g, (p) => p.M(-1, 1).L(1, -3).M(0.6, -6).L(-0.8, -10).M(-1.4, 3.4).L(-0.2, 1.6), dark(steel, 0.45), 1, m);
      else line(g, (p) => p.M(0, 3).L(0, -14), dark(steel, 0.42), 1.1, m);
      if (t === 1) line(g, (p) => p.M(-1.8, 2.5).L(-2.4, -12), rgba('#ffffff', 0.55), 0.8, m);
      // 护手、握柄、柄头
      const gc = t === 2 ? C.duskD : t === 1 ? C.gold : C.ironD;
      if (t === 1) solid(g, (p) => p.M(-8, 4).Q(-6.4, 7.4, -3, 5.8).L(3, 5.8).Q(6.4, 7.4, 8, 4).L(8.2, 7.6).Q(4, 9.6, 2.6, 8.8).L(-2.6, 8.8).Q(-4, 9.6, -8.2, 7.6).Z(), gc, { m, bevel: 1.2 });
      else solid(g, (p) => p.R(-6.6, 5, 13.2, 3.4, 1.2), gc, { m, bevel: 1.2 });
      solid(g, (p) => p.R(-1.9, 8.4, 3.8, 7.6, 1), t === 2 ? '#2e2630' : C.leatherD, { m, bevel: 1 });
      line(g, (p) => p.M(-1.8, 10.6).L(1.8, 11.5).M(-1.8, 13).L(1.8, 13.9), rgba('#000000', 0.5), 0.8, m);
      if (t === 2) gem(g, 0, 18, 2.4, C.ember, 4, m, { glow: 4, lw: 1.5 });
      else solid(g, (p) => p.E(0, 17.6, 2.3), gc, { m, bevel: 1 });
      g.restore();
    };
    one(rot(-38, 1.16, -1.8, 2), true);
    one(rot(38, 1.16, 1.8, 2), false);
  }

  // 武器 4：战锤（双手长柄 + 大锤头；t0 皮绳捆着的石锤头、t1 钢锤金箍带尖喙、t2 暗石锤头透出熔火裂纹）
  function drawHammer(g, t) {
    const m = rot(40, 1.05, -1, 2);
    const haft = t === 2 ? C.ironD : C.wood;
    tube(g, (p) => p.M(0, 27).L(0, -13), haft, 3.2, { m });
    // 握把缠绳 + 柄尾
    solid(g, (p) => p.R(-2.5, 14, 5, 9, 1), t === 2 ? '#2e2630' : C.leatherD, { m, bevel: 1 });
    line(g, (p) => p.M(-2.3, 16).L(2.3, 17.2).M(-2.3, 18.6).L(2.3, 19.8).M(-2.3, 21.2).L(2.3, 22.4), rgba('#000000', 0.5), 0.9, m);
    solid(g, (p) => p.R(-2.8, 24, 5.6, 3.6, 1.2), t === 1 ? C.gold : C.ironD, { m, bevel: 1 });
    if (t === 0) {
      // 一块打磨过的石头，用皮绳捆在木柄上
      solid(g, (p) => p.P([-13, -21, -10.6, -25, -2, -26, 9, -25.4, 13.4, -22, 13, -13.6, 9.6, -10.6, -3, -10, -10.4, -10.8, -13.6, -14]), C.stone, { m, hi: 0.32, lo: 0.5 });
      line(g, (p) => p.M(-9, -22).L(-6, -19.6).M(7, -14).L(10, -16.4), rgba('#34302c', 0.8), 1.1, m);
      tube(g, (p) => p.M(-3.4, -26.4).L(3.4, -9.6).M(3.4, -26.4).L(-3.4, -9.6), C.cord, 1.6, { m });
    } else if (t === 1) {
      // 一面平锤、一面尖喙
      solid(g, (p) => p.M(-4, -25).L(-14, -25.6).L(-15.4, -24).L(-15.4, -12).L(-14, -10.4).L(-4, -11).Z(), C.steel, { m });
      solid(g, (p) => p.M(4, -23.4).L(19, -18.4).L(4, -12.6).Z(), C.steel, { m });
      solid(g, (p) => p.R(-4.4, -26.6, 8.8, 17.2, 1.4), C.gold, { m, bevel: 1.2 });
      solid(g, (p) => p.P([0, -33, 2.4, -26.6, -2.4, -26.6]), C.steel, { m, bevel: 0.9, lw: 1.6 });
      line(g, (p) => p.M(-13.6, -22.6).L(-13.6, -13), rgba('#ffffff', 0.55), 0.9, m);
      solid(g, (p) => p.R(-2.7, -2, 5.4, 3, 1), C.gold, { m, bevel: 1 });
    } else {
      // 暗石锤头：裂纹里透出烬火
      solid(g, (p) => p.P([-15, -23, -11, -27, 11, -27, 15, -23, 15.6, -13, 11, -9, -11, -9, -15.6, -13]), '#4a4450', { m, hi: 0.3, lo: 0.5 });
      glow(g, (p) => p.M(-11, -24).L(-7, -19).L(-9.4, -14.6).L(-5, -11.4).M(9, -25).L(6, -20).L(10, -16).L(7.4, -11), C.ember, { m, stroke: 1.2, blur: 3 });
      solid(g, (p) => p.R(-3.6, -28.4, 7.2, 21, 1), C.duskD, { m, bevel: 1.1 });
      gem(g, 0, -18, 2.8, C.ember, 4, m, { glow: 5, lw: 1.5 });
    }
  }

  // 武器 5：长弓（弓身 + 弦 + 搭着的一支箭；t0 木弓、t1 反曲弓金弓梢、t2 暗弓发光弦）
  function drawBow(g, t) {
    const m = rot(40, 1.04, 2, 0);
    const wood = t === 2 ? '#4a3f52' : t === 1 ? '#a86a3a' : C.wood;
    const strCol = t === 2 ? C.abyss : '#e8dcc0';
    // 弦（先画，压在弓身底下）
    if (t === 2) glow(g, (p) => p.M(5, -25).L(5, 25), C.abyss, { m, stroke: 1, blur: 4, core: lite(C.abyss, 0.6) });
    else line(g, (p) => p.M(5, -25).L(5, 25), strCol, 1.1, m);
    // 箭：从弦伸出弓外
    tube(g, (p) => p.M(5, 0).L(-19, 0), t === 2 ? C.duskD : C.woodD, 1.4, { m });
    solid(g, (p) => p.M(5.6, 0).L(9.4, -3).L(11, -3).L(8, 0).L(11, 3).L(9.4, 3).Z(), t === 1 ? C.cloth : t === 2 ? C.abyss : C.bone, { m, bevel: 0, lw: 1.2 });
    if (t === 2) glow(g, (p) => p.P([-27, 0, -19, -3.4, -20.4, 0, -19, 3.4]), C.abyss, { m, blur: 5, core: lite(C.abyss, 0.5) });
    solid(g, (p) => p.P([-27, 0, -19, -3.4, -20.4, 0, -19, 3.4]), t === 2 ? lite(C.abyss, 0.3) : C.steel, { m, bevel: 0.8, lw: 1.4 });
    // 弓身：t1 两梢外翻
    const limb = t === 1
      ? (p) => p.M(9, -27).Q(4, -27, 3.8, -24).C(-6, -20, -9.6, -10, -9, 0).C(-9.6, 10, -6, 20, 3.8, 24).Q(4, 27, 9, 27)
      : (p) => p.M(5, -25).C(-5, -21, -9.4, -10, -9, 0).C(-9.4, 10, -5, 21, 5, 25);
    tube(g, limb, wood, 3, { m });
    // 握把
    solid(g, (p) => p.R(-11.4, -4.4, 4.8, 8.8, 1.4), t === 2 ? '#2e2630' : C.leatherD, { m, bevel: 1 });
    line(g, (p) => p.M(-11, -2).L(-7, -1).M(-11, 1).L(-7, 2), rgba('#000000', 0.5), 0.8, m);
    if (t === 1) {
      solid(g, (p) => p.E(8.6, -26.6, 1.9).E(8.6, 26.6, 1.9), C.gold, { m, bevel: 0.8, lw: 1.4 });
      solid(g, (p) => p.R(-10.6, -7, 3.4, 2, 0.6).R(-10.6, 5, 3.4, 2, 0.6), C.gold, { m, bevel: 0, lw: 1.1 });
    }
    if (t === 2) gem(g, -9, 0, 2.3, C.abyss, 4, m, { glow: 5, lw: 1.4 });
  }

  // 武器 6：太刀（修长微弯的单刃 + 扁圆镡 + 长柄缠绳；t0 直刃铁刀、t1 钢刃带霜色刃纹配金镡、t2 暗刃烬火刃口）
  function drawKatana(g, t) {
    const m = rot(45, 1.17, 0, 0.5);
    const steel = t === 2 ? '#4b4655' : t === 1 ? C.steel : C.iron;
    // 刃：刃背（左）与刃口（右）都沿同一条弧线弯，尖头斜切
    const N = 10, L = 32, y0 = 6;
    const cx = (f) => (t === 0 ? 1.2 : 3.2) * f * f; // 越往刃尖越往右弯（直刃太刀几乎不弯）
    const edge = (p) => {
      p.M(-1.8 + cx(0), y0);
      for (let i = 1; i <= N; i++) { const f = i / N; p.L(-2.1 + cx(f) - 0.2 * f, y0 - L * f); }
      p.L(1.8 + cx(1), y0 - L - 2.6); // 切先
      for (let i = N; i >= 0; i--) { const f = i / N; p.L(2.2 + cx(f) - (f > 0.9 ? (f - 0.9) * 7 : 0), y0 - L * f + (f > 0.9 ? 1.4 : 0)); }
      return p.Z();
    };
    solid(g, edge, steel, { m, bevel: 1.1 });
    if (t === 1) glow(g, (p) => { for (let i = 0; i <= 20; i++) { const f = i / 20; p[i ? 'L' : 'M'](0.6 + cx(f * 0.9) + Math.sin(f * 30) * 0.5, y0 - 2 - L * 0.9 * f); } }, C.cold, { m, stroke: 0.9, blur: 2.4, core: '#eefaff' });
    else if (t === 2) glow(g, (p) => { for (let i = 0; i <= 10; i++) { const f = i / 10; p[i ? 'L' : 'M'](1.6 + cx(f * 0.9), y0 - 2 - L * 0.9 * f); } }, C.ember, { m, stroke: 1.1, blur: 2.6 });
    else line(g, (p) => { for (let i = 0; i <= 10; i++) { const f = i / 10; p[i ? 'L' : 'M'](-0.4 + cx(f * 0.85), y0 - 2 - L * 0.85 * f); } }, dark(steel, 0.42), 1, m);
    // 镡：扁圆
    const gc = t === 2 ? C.duskD : t === 1 ? C.gold : C.ironD;
    solid(g, (p) => p.E(0, 7.6, 6.4, 2.6), gc, { m, bevel: 1.1 });
    // 柄：缠绳的菱形花纹
    const wrap = t === 2 ? '#7a1f1c' : t === 1 ? C.cloth : '#2e2630';
    solid(g, (p) => p.R(-2.2, 9.6, 4.4, 15, 1.2), wrap, { m, bevel: 1, hi: 0.35 });
    line(g, (p) => { for (let y = 10.6; y < 23.5; y += 3.2) p.M(-2, y).L(2, y + 1.6).M(2, y).L(-2, y + 1.6); }, t === 0 ? rgba(C.hide, 0.8) : rgba('#f3e2c0', 0.7), 0.9, m);
    solid(g, (p) => p.R(-2.5, 24.2, 5, 2.8, 1), gc, { m, bevel: 0.8, lw: 1.6 });
    if (t === 2) gem(g, 0, 7.6, 1.9, C.ember, 4, m, { glow: 4, lw: 1.2 });
  }

  // 武器 7：魂幡（一根高杆 + 横担上垂下的残破幡布 + 几串小骨符；
  // t0 木杆麻布、墨画的魂纹，t1 红幡金边、铜顶，t2 暗铁杆、黑幡上一道魂火青的符纹）
  function drawBanner(g, t) {
    const m = rot(18, 0.88, -6.5, 0.5);
    const pole = t === 2 ? C.duskD : t === 1 ? C.woodD : C.wood;
    const trim = t === 2 ? C.ironD : t === 1 ? C.gold : C.boneD;
    const clothC = t === 2 ? '#2d3038' : t === 1 ? C.cloth : '#cfc4a6';
    // 骨符：一根细绳吊着一小块骨片（先画绳子，压在横担下面）
    const charm = (x0, y0, x1, y1, r) => {
      line(g, (p) => p.M(x0, y0).L(x1, y1 - r), t === 2 ? rgba(ALLY, 0.7) : rgba(C.cord, 0.95), 1, m);
      solid(g, (p) => p.M(x1, y1 - r * 1.3).L(x1 + r * 0.8, y1).L(x1, y1 + r * 1.5).L(x1 - r * 0.8, y1).Z(), C.bone, { m, bevel: 0.8, lw: 1.4, hi: 0.4 });
    };
    charm(-1.4, -19, -6, -8, 2.2);
    charm(16, -20, 18.4, -9.5, 2);
    charm(16, -20, 15.6, -3.6, 1.7);
    // 杆
    tube(g, (p) => p.M(0, 29).L(0, -23), pole, 2.9, { m });
    // 幡布：从横担垂下，右缘随风微摆，下摆撕成参差的布条
    const cloth = (p) => p.M(1.4, -19).L(14, -19.4).C(14.8, -11, 12.6, -3, 14.6, 5).L(12.4, 2.6).L(11, 8.6).L(9, 3.4).L(7, 10).L(5.4, 4.6).L(3.4, 8.2).L(2, 3).C(1, -4, 2.6, -11, 1.4, -19).Z();
    solid(g, cloth, clothC, { m, hi: 0.22, lo: 0.5, bevel: 1.1, lw: 1.9 });
    // 布上的破口与纹样
    solid(g, (p) => p.P([10.2, -6, 11.6, -4.6, 10.8, -2.8, 9.6, -4.2]), dark(clothC, 0.55), { m, bevel: 0, lw: 1 });
    if (t === 0) {
      // 墨画的魂纹：一个圈 + 下垂的三笔
      line(g, (p) => p.E(7.6, -12.6, 2.6).M(7.6, -9.6).L(7.6, -3).M(5.4, -8).L(4.6, -4).M(9.8, -8).L(10.4, -4.4), rgba('#3a2a22', 0.85), 1.2, m);
    } else if (t === 1) {
      line(g, (p) => p.M(2.6, -16.6).L(13, -16.8).M(2.6, -16.6).C(2.2, -8, 3, -2, 2.8, 2), lite(C.gold, 0.1), 1.1, m);
      glow(g, (p) => p.P([7.8, -14.4, 10.2, -10.6, 7.8, -6.8, 5.4, -10.6]), C.gold, { m, blur: 3, core: lite(C.gold, 0.45) });
      line(g, (p) => p.M(7.8, -6).L(7.8, -0.6), rgba(C.gold, 0.9), 1.1, m);
    } else {
      // 魂火青的符纹：发光的眼形 + 往下淌的一道
      glow(g, (p) => p.M(4, -11).Q(7.8, -15.4, 11.6, -11).Q(7.8, -6.6, 4, -11).Z(), ALLY, { m, stroke: 1.2, blur: 5, core: '#c9fff2' });
      glow(g, (p) => p.E(7.8, -11, 1.3), ALLY, { m, blur: 5, core: '#f2fffb' });
      glow(g, (p) => p.M(7.8, -7.6).L(7.2, -3).L(8.4, 0.6), ALLY, { m, stroke: 1, blur: 4, core: '#c9fff2' });
    }
    // 横担
    tube(g, (p) => p.M(-2.2, -19.6).L(16.4, -20.2), pole, 2, { m });
    solid(g, (p) => p.E(16.6, -20.2, 1.6), trim, { m, bevel: 0.6, lw: 1.3 });
    // 杆顶
    if (t === 0) {
      solid(g, (p) => p.E(0, -25, 3.1, 2.8), C.bone, { m, bevel: 1, lw: 1.7 });
      solid(g, (p) => p.E(-1.1, -25.4, 0.8).E(1.1, -25.4, 0.8), '#3a2a22', { m, bevel: 0, lw: 0 });
    } else if (t === 1) {
      solid(g, (p) => p.R(-2.4, -24.4, 4.8, 2.8, 0.8), C.gold, { m, bevel: 0.8, lw: 1.5 });
      solid(g, (p) => p.P([0, -32, 2.6, -25, 0, -23.6, -2.6, -25]), C.copper, { m, bevel: 0.9, lw: 1.6 });
    } else {
      // 一弯暗铁月钩托着一点魂火
      solid(g, (p) => p.M(-1.6, -22).Q(-7, -27, -3, -32).Q(-4, -27.6, 0, -25).Q(4, -27.6, 3, -32).Q(7, -27, 1.6, -22).Z(), C.ironD, { m, bevel: 1, lw: 1.6 });
      gem(g, 0, -27.6, 2.1, ALLY, 4, m, { glow: 5, lw: 1.3 });
    }
    // 握把缠布 + 杆尾
    solid(g, (p) => p.R(-2.3, 11, 4.6, 8.4, 1), t === 2 ? '#2e2630' : C.leatherD, { m, bevel: 1 });
    line(g, (p) => p.M(-2.1, 13).L(2.1, 14.1).M(-2.1, 15.6).L(2.1, 16.7), rgba('#000000', 0.5), 0.9, m);
    solid(g, (p) => p.P([-1.8, 27, 1.8, 27, 0, 31.4]), trim, { m, bevel: 0.6, lw: 1.4 });
  }

  // 头盔（皮盔 / 铁盔 / 烬钢盔）
  function drawHelm(g, t) {
    if (t === 0) {
      solid(g, (p) => p.M(-15, 5).L(-13.5, 17).Q(-10, 19, -8, 15.5).L(-8, 5).Z(), C.leatherD, {});
      solid(g, (p) => p.M(15, 5).L(13.5, 17).Q(10, 19, 8, 15.5).L(8, 5).Z(), C.leatherD, {});
      solid(g, (p) => p.M(-16, 5).C(-18, -24, 18, -24, 16, 5).Z(), C.leather, {});
      solid(g, (p) => p.M(-17, 2).Q(0, -3, 17, 2).L(17, 7.5).Q(0, 2.5, -17, 7.5).Z(), C.hide, { bevel: 1.4 });
      line(g, (p) => p.M(0, -1).L(0, -17), rgba('#2a160a', 0.75), 1.2, null, [2.4, 2.2]);
      solid(g, (p) => p.E(0, -18.6, 2.3), C.hide, { bevel: 1 });
    } else if (t === 1) {
      solid(g, (p) => p.M(-15, 3).L(-14, 18).L(-7.5, 20).L(-6, 6).Z(), C.ironD, {});
      solid(g, (p) => p.M(15, 3).L(14, 18).L(7.5, 20).L(6, 6).Z(), C.ironD, {});
      solid(g, (p) => p.M(-16, 5).C(-18, -25, 18, -25, 16, 5).Z(), C.iron, {});
      solid(g, (p) => p.R(-2.6, -19, 5.2, 39, 1.6), C.steel, { bevel: 1.4 });
      solid(g, (p) => p.M(-17.5, 2).Q(0, -2, 17.5, 2).L(17.5, 7).Q(0, 3, -17.5, 7).Z(), C.steel, { bevel: 1.4 });
      for (const x of [-13, -7.5, 7.5, 13]) solid(g, (p) => p.E(x, 4.2 - Math.abs(x) * 0.02, 1.15), C.ironD, { bevel: 0, lw: 1.3 });
    } else {
      // 两侧的翼刃
      solid(g, (p) => p.P([-14, -6, -25, -21, -20.5, -3.5, -15, 3]), C.duskD, {});
      solid(g, (p) => p.P([14, -6, 25, -21, 20.5, -3.5, 15, 3]), C.duskD, {});
      solid(g, (p) => p.M(-15, 20).L(-16, 2).C(-17, -25, 17, -25, 16, 2).L(15, 20).L(5.5, 22).L(3.2, 12).L(-3.2, 12).L(-5.5, 22).Z(), C.dusk, {});
      solid(g, (p) => p.P([0, -24, 3.2, -12, 0, 1, -3.2, -12]), C.duskD, { bevel: 1.2 });
      glow(g, (p) => p.P([-11.5, 1.5, -2.5, 3.5, -2.5, 6.8, -11.5, 5.5]).P([11.5, 1.5, 2.5, 3.5, 2.5, 6.8, 11.5, 5.5]), C.ember, { blur: 6 });
    }
  }

  // 胸甲（皮甲 / 锁甲 / 烬钢甲）
  function drawBody(g, t) {
    const sil = (p) => p.M(-19, -17).L(-9, -21).Q(0, -13, 9, -21).L(19, -17).L(22, -6).L(14.5, -2.5).L(15, 21).L(-15, 21).L(-14.5, -2.5).L(-22, -6).Z();
    if (t === 0) {
      solid(g, sil, C.leather, {});
      solid(g, (p) => p.R(-15.6, 9.5, 31.2, 4.6, 1), C.leatherD, { bevel: 1.2 });
      solid(g, (p) => p.R(-3, 8.8, 6, 6, 1), C.ironD, { bevel: 1, lw: 1.6 });
      line(g, (p) => p.M(0, -14.5).L(0, 8), rgba('#2a160a', 0.7), 1.3);
      line(g, (p) => p.M(-4, -11).L(4, -7).M(4, -11).L(-4, -7).M(-4, -4).L(4, 0).M(4, -4).L(-4, 0), lite(C.hide, 0.3), 1.2);
      line(g, (p) => p.M(-19, -8).L(-13.5, -5.5).M(19, -8).L(13.5, -5.5), rgba('#2a160a', 0.6), 1.1);
    } else if (t === 1) {
      solid(g, sil, C.iron, {});
      // 锁环纹
      g.save();
      g.beginPath();
      sil(pen(g));
      g.clip();
      g.lineWidth = 1;
      g.strokeStyle = rgba('#1c232b', 0.55);
      for (let r = 0; r < 9; r++) {
        for (let c = -5; c <= 5; c++) {
          const x = c * 4.6 + (r % 2 ? 2.3 : 0), y = -15 + r * 4.4;
          g.beginPath();
          g.arc(x, y, 2.3, 0.15 * Math.PI, 0.85 * Math.PI);
          g.stroke();
        }
      }
      g.restore();
      solid(g, (p) => p.M(-9.5, -21.5).Q(0, -13, 9.5, -21.5).L(7, -16.5).Q(0, -9.5, -7, -16.5).Z(), C.gold, { bevel: 1.2, lw: 1.8 });
      solid(g, (p) => p.R(-15.8, 16.4, 31.6, 4.8, 1), C.ironD, { bevel: 1.2 });
    } else {
      solid(g, (p) => p.M(-12, -19).Q(0, -12, 12, -19).L(15, -3).L(12.5, 21).L(-12.5, 21).L(-15, -3).Z(), C.dusk, {});
      solid(g, (p) => p.M(-10, -17).C(-18, -24, -27, -17, -24, -6).Q(-17, -6, -12.5, -8.5).Z(), C.duskD, {});
      solid(g, (p) => p.M(10, -17).C(18, -24, 27, -17, 24, -6).Q(17, -6, 12.5, -8.5).Z(), C.duskD, {});
      line(g, (p) => p.M(-13.5, 5).Q(0, 10, 13.5, 5).M(-13, 12.5).Q(0, 17.5, 13, 12.5), rgba('#000000', 0.5), 1.3);
      glow(g, (p) => p.M(0, -3).L(0, 19).M(-6, -9).L(-11, -1).M(6, -9).L(11, -1), C.ember, { stroke: 1.1, blur: 4 });
      gem(g, 0, -6.5, 4.6, C.ember, 4, null, { glow: 7 });
    }
  }

  // 手套（皮手套 / 铁护手 / 烬钢护手）
  function drawGloves(g, t) {
    const m = rot(-12, 1.04, -1, 0);
    const base = t === 2 ? C.dusk : t === 1 ? C.iron : C.leather;
    const cuff = t === 2 ? C.duskD : t === 1 ? C.steel : C.hide;
    // 拇指在后
    solid(g, (p) => p.M(8, 6).Q(17.5, 2, 17, -8).Q(15.5, -13, 11.5, -9.5).L(8, -3).Z(), base, { m });
    solid(g, (p) => p.M(-10, 9).L(-11, -8).Q(-11.5, -21, -6.4, -21.5).Q(-3.4, -22, -3, -18.5).Q(-2, -24.5, 2.4, -23.5).Q(5, -23, 5, -18).Q(7, -22, 10, -19.5).Q(11.6, -18, 10.6, -8).L(10, 9).Z(), base, { m });
    line(g, (p) => p.M(-3.2, -18).L(-3.4, -7).M(4.6, -17.5).L(4.2, -7), rgba('#000000', 0.45), 1.2, m);
    if (t >= 1) {
      line(g, (p) => p.M(-10.5, -13).L(-3.5, -13.5).M(-3.2, -15.5).L(4.6, -15).M(4.8, -12.5).L(10.4, -12).M(-10.6, -6).L(10.4, -5), rgba('#000000', 0.42), 1.1, m);
    }
    if (t === 2) glow(g, (p) => p.E(-7, -2, 1.5).E(-1.6, -3, 1.5).E(3.8, -2.6, 1.5).E(8.4, -1.4, 1.3), C.ember, { m, blur: 4 });
    // 袖口
    if (t === 0) {
      solid(g, (p) => p.M(-11.5, 8).L(11.5, 8).L(13, 21).L(-13, 21).Z(), cuff, { m });
      line(g, (p) => p.M(-10.5, 11.6).L(10.8, 11.6), rgba('#2a160a', 0.7), 1.1, m, [2.4, 2]);
    } else {
      solid(g, (p) => p.M(-11.5, 7).L(11.5, 7).L(15.5, 22).L(-15.5, 22).Z(), cuff, { m });
      solid(g, (p) => p.R(-12.4, 6, 24.8, 3.6, 1.2), t === 2 ? C.dusk : C.ironD, { m, bevel: 1 });
      if (t === 1) for (const x of [-9, -3, 3, 9]) solid(g, (p) => p.E(x * 1.15, 17.5, 1.1), C.ironD, { m, bevel: 0, lw: 1.2 });
      else glow(g, (p) => p.M(-10, 14).L(0, 18.5).L(10, 14), C.ember, { m, stroke: 1.1, blur: 4 });
    }
  }

  // 鞋子（皮靴 / 铁胫甲 / 烬钢靴）
  function drawBoots(g, t) {
    const base = t === 2 ? C.dusk : t === 1 ? C.iron : C.leather;
    const m = rot(0, 1.02, -2, -1);
    solid(g, (p) => p.M(-13, 19).L(23, 19).L(23, 23).L(-13, 23).Z(), t === 0 ? '#3a2416' : '#2c2a30', { m, bevel: 1 });
    if (t === 2) solid(g, (p) => p.M(-10, -21).L(4, -21).L(5.5, 2).Q(15, 3.5, 26, 13).L(22.5, 19.5).L(-11.5, 19.5).Z(), base, { m });
    else solid(g, (p) => p.M(-10, -21).L(4, -21).L(5.5, 2).Q(18, 4, 21.5, 13).L(21.5, 19.5).L(-11.5, 19.5).Z(), base, { m });
    if (t === 0) {
      solid(g, (p) => p.M(-11.5, -22.5).L(5.5, -22.5).L(6, -14.5).L(-12, -13.5).Z(), C.hide, { m, bevel: 1.3 });
      line(g, (p) => p.M(2, -9).L(5.4, -7.6).M(2.2, -4.6).L(5.6, -3.2).M(3, 0).L(6.6, 1.6), lite(C.hide, 0.35), 1.3, m);
      line(g, (p) => p.M(-10.5, 12).Q(4, 9, 21, 13.5), rgba('#2a160a', 0.6), 1.1, m, [2.4, 2]);
    } else {
      // 护膝、胫甲的接缝、鞋头
      solid(g, (p) => p.M(-12, -17).Q(-3, -29, 6.5, -17).Q(-3, -11, -12, -17).Z(), t === 2 ? C.duskD : C.steel, { m, bevel: 1.3 });
      line(g, (p) => p.M(-10.4, -7).L(4.6, -8).M(-10.8, 1).L(5.4, 0).M(-11.2, 9.5).Q(4, 7, 13, 6), rgba('#000000', 0.45), 1.2, m);
      solid(g, (p) => (t === 2 ? p.M(13, 6).Q(20, 8, 26, 13).L(22.5, 19.5).L(12, 19.5).Z() : p.M(12.5, 7.5).Q(20, 8.5, 21.5, 13).L(21.5, 19.5).L(12, 19.5).Z()), t === 2 ? C.duskD : C.ironD, { m, bevel: 1.2 });
      if (t === 2) {
        glow(g, (p) => p.M(-3, -6).L(-3, 6).M(-7.5, 13).L(8, 12), C.ember, { m, stroke: 1.1, blur: 4 });
        gem(g, -3, -19, 2.6, C.ember, 4, m, { glow: 5 });
      } else {
        for (const y of [-4, 4.4]) solid(g, (p) => p.E(-7, y, 1.1), C.ironD, { m, bevel: 0, lw: 1.2 });
      }
    }
  }

  // 腰带（皮带 / 重腰带 / 符文腰带）
  function drawBelt(g, t) {
    const strap = t === 2 ? '#463c4e' : t === 1 ? C.leatherD : C.leather;
    const w = t === 0 ? 8 : 10.5;
    tube(g, (p) => p.M(-26, -5).Q(0, 9, 26, -5), strap, w, { cap: 'butt' });
    if (t === 0) {
      line(g, (p) => p.M(-24, -7.2).Q(0, 6.6, 24, -7.2), rgba('#2a160a', 0.55), 0.9, null, [2.2, 2]);
      for (const x of [9, 14, 19]) solid(g, (p) => p.E(x, 1.2 - (x * x) / 96 + 1.2, 0.9), '#2a160a', { bevel: 0, lw: 0 });
      solid(g, (p) => p.R(-7, -4.6, 13, 13.4, 2).R(-3.6, -1.4, 6.2, 7, 1), C.iron, { rule: 'evenodd', bevel: 1.3 });
      solid(g, (p) => p.R(-4.4, 1.2, 8.6, 1.9, 0.8), C.ironD, { bevel: 0, lw: 1.3 });
    } else if (t === 1) {
      for (const x of [-21, -15, 15, 21]) solid(g, (p) => p.E(x, 1.8 - (x * x) / 100, 1.5), C.gold, { bevel: 0.8, lw: 1.3 });
      solid(g, (p) => p.R(-9.5, -8, 19, 19, 3), C.gold, { bevel: 1.6 });
      solid(g, (p) => p.R(-5.6, -4.2, 11.2, 11.4, 1.6), C.ironD, { bevel: 1.2, lw: 1.6 });
      solid(g, (p) => p.P([0, -2, 3.4, 1.5, 0, 5, -3.4, 1.5]), C.gold, { bevel: 0.8, lw: 1.3 });
    } else {
      // 三块嵌着符文的甲片
      const plate = (x, y, a) => {
        const m = rot(a, 1, x, y);
        solid(g, (p) => p.P([-5.2, -6.6, 5.2, -6.6, 6.6, 0, 5.2, 6.6, -5.2, 6.6, -6.6, 0]), C.duskD, { m, bevel: 1.3 });
        return m;
      };
      let m = plate(-16.5, -0.6, 14);
      glow(g, (p) => p.M(-2, -3).L(2, 0).L(-2, 3), C.mana, { m, stroke: 1.1, blur: 4 });
      m = plate(16.5, -0.6, -14);
      glow(g, (p) => p.M(2, -3).L(-2, 0).L(2, 3), C.mana, { m, stroke: 1.1, blur: 4 });
      m = plate(0, 2.4, 0);
      solid(g, (p) => p.P([-7.4, -8.4, 7.4, -8.4, 9, 0, 7.4, 8.4, -7.4, 8.4, -9, 0]), C.dusk, { m: rot(0, 1, 0, 2.4), bevel: 1.5 });
      glow(g, (p) => p.M(0, -4.6).L(0, 4.6).M(-3.2, -1.6).L(0, 1.4).L(3.2, -1.6), C.mana, { m, stroke: 1.2, blur: 5 });
    }
  }

  // 戒指（赤铜戒 / 霜银戒 / 雷纹戒 / 灵石戒）：按 baseIdx 区分
  function drawRing(g, idx) {
    const band = [C.copper, C.silver, '#b08a3c', C.stone][idx];
    const jewel = [C.fire, C.cold, C.light, C.mana][idx];
    solid(g, (p) => p.E(0, 7.5, 16, 14.5).E(0, 7.5, 10.4, 9.2), band, { rule: 'evenodd', bevel: 1.8 });
    if (idx === 2) line(g, (p) => p.M(-13, 11).L(-10.5, 15).L(-8.6, 12.6).L(-5.4, 17.4).M(13, 11).L(10.5, 15).L(8.6, 12.6).L(5.4, 17.4), dark(band, 0.55), 1.1);
    if (idx === 3) line(g, (p) => p.M(-13.4, 5).L(-11, 8.6).M(12, 12.5).L(13.6, 9).M(-4, 20.4).L(-1.4, 18.6), dark(band, 0.5), 1.1);
    // 戒托
    solid(g, (p) => p.P([-6.4, -6, 6.4, -6, 4.6, -1.2, -4.6, -1.2]), dark(band, 0.12), { bevel: 1.1, lw: 1.8 });
    if (idx === 0) gem(g, 0, -11.5, 6.6, jewel, 8, null, { ky: 0.86 });
    else if (idx === 1) gem(g, 0, -12.5, 7, jewel, 4, null, { ky: 1.15 });
    else if (idx === 2) gem(g, 0, -11.5, 6.4, jewel, 4, null, { a0: -Math.PI / 4 });
    else gem(g, 0, -11.5, 6.4, jewel, 10, null);
  }

  // 护符（骨坠 / 血石坠 / 星芒坠）
  function drawAmulet(g, idx) {
    tube(g, (p) => p.M(-19, -27).Q(-15, -6, 0, -3).Q(15, -6, 19, -27), idx === 0 ? C.cord : idx === 1 ? C.gold : C.silver, 1.9, {});
    if (idx === 0) {
      solid(g, (p) => p.R(-3.4, -5.4, 6.8, 4.4, 1.2), C.leatherD, { bevel: 1, lw: 1.7 });
      solid(g, (p) => p.M(-4.6, -1.4).L(4.6, -1.4).Q(6.4, 12, -3.4, 23.5).Q(-1.4, 10, -4.6, -1.4).Z(), C.bone, {});
      line(g, (p) => p.M(-1.6, 3).L(2.6, 3.4).M(-1, 8).L(2.4, 8.2), dark(C.bone, 0.45), 1);
    } else if (idx === 1) {
      solid(g, (p) => p.E(0, -3.6, 2.6), C.gold, { bevel: 0.8, lw: 1.5 });
      solid(g, (p) => p.M(0, -2.5).C(13, 7, 11.5, 22.5, 0, 22.5).C(-11.5, 22.5, -13, 7, 0, -2.5).Z(), C.gold, {});
      glow(g, (p) => p.M(0, 3).C(8, 10, 7, 18.5, 0, 18.5).C(-7, 18.5, -8, 10, 0, 3).Z(), C.blood, { blur: 5, core: C.blood });
      solid(g, (p) => p.M(0, 3).C(8, 10, 7, 18.5, 0, 18.5).C(-7, 18.5, -8, 10, 0, 3).Z(), C.blood, { hi: 0.5, lo: 0.5, bevel: 1.3, lw: 1.6 });
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.arc(-2.4, 9.6, 1.4, 0, TAU);
      g.fill();
    } else {
      solid(g, (p) => p.E(0, -3.8, 2.4), C.silver, { bevel: 0.8, lw: 1.5 });
      const pts = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU - Math.PI / 2, r = i % 4 === 0 ? 15 : i % 2 === 0 ? 10 : 5.6;
        pts.push(Math.cos(a) * r, 10 + Math.sin(a) * r);
      }
      glow(g, (p) => p.P(pts), C.light, { blur: 7, core: C.light });
      solid(g, (p) => p.P(pts), '#ffe9a0', { hi: 0.6, lo: 0.3, bevel: 0.9, lw: 1.7, shine: 0.6 });
      gem(g, 0, 10, 4, '#fffbe6', 8, null, { glow: 6, lw: 1.2 });
    }
  }

  // ---------- 远程武器 ----------
  // 机炮（铆钉机炮 / 转膛机炮 / 熔轮机炮）：三根枪管 + 方机匣 + 侧挂弹鼓 + 后握把；t0 铆钉铁皮、t1 钢管铜箍、t2 暗钢管口烧红
  function drawGatling(g, t) {
    const m = rot(45, 1.08, -1, 1.5);
    const metal = t === 2 ? '#3d3944' : t === 1 ? C.steel : C.iron, ring = t === 1 ? C.gold : t === 2 ? C.copper : C.ironD;
    for (const x of [-3.8, 0, 3.8]) tube(g, (p) => p.M(x, -1).L(x, -26), dark(metal, x ? 0.18 : 0.05), 2.7, { m });
    if (t === 2) for (const x of [-3.8, 0, 3.8]) glow(g, (p) => p.E(x, -26.5, 1.6), C.ember, { m, blur: 4, core: lite(C.ember, 0.4) });
    solid(g, (p) => p.R(-7, -24.5, 14, 3.2, 1.2).R(-7, -13, 14, 3.2, 1.2), ring, { m, bevel: 0.8, lw: 1.6 });
    solid(g, (p) => p.R(-7.4, -2, 14.8, 15, 2.2), metal, { m });
    line(g, (p) => p.M(-4.4, 1.5).L(4.4, 1.5).M(-4.4, 4.5).L(4.4, 4.5).M(-4.4, 7.5).L(4.4, 7.5), t === 2 ? rgba(C.ember, 0.9) : rgba('#000000', 0.45), 1.1, m);
    if (t === 0) for (const [x, y] of [[-5.4, 0], [5.4, 0], [-5.4, 11], [5.4, 11]]) solid(g, (p) => p.E(x, y, 0.9), C.ironD, { m, bevel: 0, lw: 0.8 });
    solid(g, (p) => p.E(10.5, 6, 5.4), t === 1 ? C.gold : C.ironD, { m, hi: 0.45, bevel: 1.1 });
    solid(g, (p) => p.E(10.5, 6, 2.2), dark(metal, 0.3), { m, bevel: 0, lw: 1.2 });
    solid(g, (p) => p.M(-2.8, 12.6).L(2.6, 12.6).L(4.6, 23).L(-0.6, 23.4).Z(), C.leatherD, { m, bevel: 1 });
    solid(g, (p) => p.R(-9.4, -9, 3.2, 8, 1), C.leatherD, { m, bevel: 0.8, lw: 1.5 });
  }
  // 喷枪（铁皮喷枪 / 焚炉喷枪 / 熔岩喷枪）：输焰管 + 喇叭喷嘴 + 骑在上面的燃料罐 + 引火；t0 灰铁皮、t1 铜罐、t2 黑曜石罐透出熔岩
  function drawFlamer(g, t) {
    const m = rot(45, 1.08, -1, 1.5);
    const metal = t === 2 ? '#3a3540' : C.iron, tank = t === 2 ? '#2a2228' : t === 1 ? C.copper : '#8a8f96';
    tube(g, (p) => p.M(0, 6).L(0, -20), metal, 3.6, { m });
    solid(g, (p) => p.M(-2.6, -19).L(-6, -27).L(6, -27).L(2.6, -19).Z(), dark(metal, 0.1), { m, bevel: 0.9 });
    glow(g, (p) => p.E(0, -28.5, 3.2, 1.8), C.fire, { m, blur: 6, core: lite(C.fire, 0.5) });
    solid(g, (p) => p.R(-11.5, -14, 7.4, 20, 3.6), tank, { m, hi: 0.45 });
    solid(g, (p) => p.R(-12, -9, 8.4, 2.2, 0.8).R(-12, 1, 8.4, 2.2, 0.8), t === 1 ? C.ironD : C.gold, { m, bevel: 0, lw: 1.3 });
    if (t === 2) glow(g, (p) => p.M(-9, -12).L(-7, -7).L(-9, -3).L(-6.6, 3), C.ember, { m, stroke: 1.2, blur: 3 });
    solid(g, (p) => p.E(-7.8, -16.4, 2.4), C.silver, { m, bevel: 0.6, lw: 1.3 });
    line(g, (p) => p.M(-7.8, -16.4).L(-6.6, -17.6), '#a8261c', 0.9, m);
    solid(g, (p) => p.R(-4.6, 5, 9.2, 8, 1.6), metal, { m });
    solid(g, (p) => p.M(-2.6, 12.4).L(2.6, 12.4).L(4.4, 22.6).L(-0.6, 23).Z(), C.leatherD, { m, bevel: 1 });
    solid(g, (p) => p.R(2.4, -6, 3, 7, 1), C.leatherD, { m, bevel: 0.8, lw: 1.5 });
  }
  // 烬铸左轮：发黑的八棱长管、粗转轮、焦黑骨木握把，枪身烧着余烬的裂纹（只有一档）
  function drawRevolver(g, t) {
    const m = rot(45, 1.15, 0, 1);
    t = t || 0; // 三档名字相同、只用得到第 0 档；另两档只在细节上区分（图标各不相同）
    const blk = '#2e2628';
    glow(g, (p) => p.E(0, -6, 12, 18), C.ember, { m, blur: 10, core: rgba(C.ember, 0.12) });
    solid(g, (p) => p.R(-2.6, -27, 5.2, 21, 1), blk, { m, hi: 0.35 });
    solid(g, (p) => p.R(-1.6, -27, 3.2, 1.6, 0.6).R(-0.8, -29, 1.6, 2.4, 0.4), C.gold, { m, bevel: 0, lw: 1.2 });
    glow(g, (p) => p.M(1.6, -8).L(1, -15).L(1.8, -20).L(1.2, -25), C.ember, { m, stroke: 1, blur: 3 });
    solid(g, (p) => p.R(-5.8, -7, 11.6, 9.6, 2.4), blk, { m, hi: 0.4 });
    for (const y of [-4.6, -2.2, 0.2]) line(g, (p) => p.M(-5, y).L(5, y), rgba('#000000', 0.5), 0.8, m);
    for (const x of [-3.2, 0, 3.2]) glow(g, (p) => p.E(x, -5.6, 0.9), C.ember, { m, blur: 3, core: '#ffd2a0' });
    solid(g, (p) => p.M(-4.4, 2.4).L(4, 2.4).L(3.4, 7).L(-4.6, 7).Z(), blk, { m });
    solid(g, (p) => p.M(-3.6, 6.2).L(2.4, 6.2).L(7, 21).Q(3.4, 23.4, 0.6, 21.6).Z(), '#4a2a1c', { m, bevel: 1.1 });
    solid(g, (p) => p.E(4.6, 20.4, 1.6), C.gold, { m, bevel: 0, lw: 1.1 });
    tube(g, (p) => p.M(-1.6, 7.2).Q(-4.6, 10, -1.4, 12), blk, 1.2, { m });
    solid(g, (p) => p.P([-3.6, 2.4, -6.4, -1, -4, -1]), blk, { m, bevel: 0, lw: 1.3 });
    if (t >= 1) glow(g, (p) => p.M(-1.6, -9).L(-1, -14).L(-1.8, -19), C.ember, { m, stroke: 0.9, blur: 3 });
    if (t >= 2) gem(g, 1.4, 14, 1.8, C.ember, 4, m, { glow: 4, lw: 1.1 });
  }
  // 弓的共用骨架：弦 + 搭着的箭 + 弓身（limb 由各弓给），握把
  function bowBase(g, m, limb, wood, strCol, arrowTip, glowStr) {
    if (glowStr) glow(g, (p) => p.M(5, -25).L(5, 25), glowStr, { m, stroke: 1, blur: 4, core: lite(glowStr, 0.6) });
    else line(g, (p) => p.M(5, -25).L(5, 25), strCol, 1.1, m);
    tube(g, (p) => p.M(5, 0).L(-19, 0), C.woodD, 1.4, { m });
    solid(g, (p) => p.M(5.6, 0).L(9.4, -3).L(11, -3).L(8, 0).L(11, 3).L(9.4, 3).Z(), C.bone, { m, bevel: 0, lw: 1.2 });
    solid(g, (p) => p.P([-27, 0, -19, -3.4, -20.4, 0, -19, 3.4]), arrowTip, { m, bevel: 0.8, lw: 1.4 });
    tube(g, limb, wood, 3, { m });
  }
  // 猎弓（桦木猎弓 / 追猎弓 / 影羽猎弓）：短而弯的反曲弓，梢头外卷；t1 青绿猎绳、t2 乌木弓配影羽和青色猎眼
  function drawHuntbow(g, t) {
    const m = rot(40, 1.06, 2, 0);
    const wood = t === 0 ? '#c9a27a' : t === 1 ? '#5a4030' : '#2e2830';
    const limb = (p) => p.M(10.5, -24).Q(6.5, -27, 5, -23).C(-2, -21, -10, -12, -9, 0).C(-10, 12, -2, 21, 5, 23).Q(6.5, 27, 10.5, 24);
    bowBase(g, m, limb, wood, '#e8dcc0', C.steel, null);
    solid(g, (p) => p.E(10.6, -24, 1.7).E(10.6, 24, 1.7), C.bone, { m, bevel: 0.6, lw: 1.3 });
    solid(g, (p) => p.R(-11.4, -4.4, 4.8, 8.8, 1.4), t === 0 ? C.leatherD : '#23443e', { m, bevel: 1 });
    if (t >= 1) line(g, (p) => p.M(-11.2, -2).L(-6.8, -1).M(-11.2, 1).L(-6.8, 2), '#5fbfa8', 1, m);
    if (t === 2) {
      gem(g, -10.6, 0, 2.2, ALLY, 4, m, { glow: 5, lw: 1.3 });
      solid(g, (p) => p.M(8, -2.6).L(13.4, -6).L(13, -3).L(9, 0).L(13, 3).L(13.4, 6).L(8, 2.6).Z(), '#3a3346', { m, bevel: 0, lw: 1.1 });
    }
  }
  // 符文弓（刻纹弓 / 符文弓 / 辉纹符文弓）：灰蓝石纹弓臂、银包角，弓臂上的符刻随档次越来越亮
  function drawRunebow(g, t) {
    const m = rot(40, 1.05, 2, 0);
    const wood = t === 2 ? '#3c4660' : '#5a6680', rune = t === 2 ? '#c9a6ff' : t === 1 ? '#9fd0ff' : '#7c8aa6';
    const limb = (p) => p.M(5, -25).C(-4, -21, -10, -10, -9.6, 0).C(-10, 10, -4, 21, 5, 25);
    bowBase(g, m, limb, wood, '#e2e8f4', C.silver, t === 2 ? '#c9a6ff' : null);
    solid(g, (p) => p.P([5, -25, 8, -28, 7, -23]).P([5, 25, 8, 28, 7, 23]), C.silver, { m, bevel: 0, lw: 1.2 });
    solid(g, (p) => p.R(-11.6, -4.6, 5, 9.2, 1.4), '#2a2232', { m, bevel: 1 });
    const marks = (p) => p.M(-8.6, -8).L(-7, -10).M(-6.4, -14).L(-4.4, -15.4).M(-3.4, -19).L(-1.4, -20).M(-8.6, 8).L(-7, 10).M(-6.4, 14).L(-4.4, 15.4).M(-3.4, 19).L(-1.4, 20);
    if (t >= 1) glow(g, marks, rune, { m, stroke: 1.3, blur: t === 2 ? 5 : 3 });
    else line(g, marks, rune, 1.2, m);
    glow(g, (p) => p.E(-9, 0, 4.6), rune, { m, stroke: 1, blur: t ? 4 : 1, core: rgba(lite(rune, 0.4), t ? 0.9 : 0.5) });
  }
  // 烬铸弓：烧黑的铁弓臂棱角分明，弓背伸出刃状尖刺，弓臂熔开的裂纹、握把托着一团余烬（只有一档）
  function drawEmberbow(g, t) {
    const m = rot(40, 1.06, 2, 0);
    t = t || 0;
    glow(g, (p) => p.E(-4, 0, 14, 22), C.ember, { m, blur: 10, core: rgba(C.ember, 0.12) });
    const limb = (p) => p.M(5, -25).L(-2, -21).L(-8, -13).L(-9.6, 0).L(-8, 13).L(-2, 21).L(5, 25);
    bowBase(g, m, limb, '#2a1e1c', '#e8c8a0', '#ffb066', '#ff8a3c');
    solid(g, (p) => p.P([-6, -15, -14, -19, -8.6, -11]).P([-6, 15, -14, 19, -8.6, 11]).P([0, -22, -3, -29, 1.6, -23]).P([0, 22, -3, 29, 1.6, 23]), '#3a2622', { m, bevel: 0, lw: 1.3 });
    glow(g, (p) => p.M(-3, -19).L(-6.6, -14).L(-8.2, -8).M(-3, 19).L(-6.6, 14).L(-8.2, 8), C.ember, { m, stroke: 1.2, blur: 3 });
    solid(g, (p) => p.R(-11.8, -4.6, 5, 9.2, 1.4), '#2a1610', { m, bevel: 1 });
    gem(g, -13.6, 0, 2.6, C.ember, 4, m, { glow: 6, lw: 1.3 });
    if (t >= 1) glow(g, (p) => p.E(5, -25, 1.6).E(5, 25, 1.6), C.ember, { m, blur: 4, core: '#ffd2a0' });
    if (t >= 2) glow(g, (p) => p.M(-16, -3).L(-19, 0).L(-16, 3), C.ember, { m, stroke: 1.1, blur: 3 });
  }

  const WEAPON_TYPES = ['blade', 'staff', 'wand', 'daggers', 'hammer', 'eagle', 'katana', 'banner'];
  const WEAPON_DRAW = {
    blade: drawBlade, staff: drawStaff, wand: drawWand, daggers: drawDaggers, hammer: drawHammer, bow: drawBow, eagle: drawBow, katana: drawKatana, banner: drawBanner,
    gatling: drawGatling, flamer: drawFlamer, revolver: drawRevolver, huntbow: drawHuntbow, runebow: drawRunebow, emberbow: drawEmberbow,
  };
  function weaponType(baseIdx) {
    const b = G.BASES && G.BASES.weapon && G.BASES.weapon[baseIdx];
    return (b && WEAPON_DRAW[b.type] ? b.type : WEAPON_TYPES[baseIdx]) || 'blade';
  }
  // 各部位的图稿大小不一，统一放大到差不多占满格子
  const ITEM_SCALE = { weapon: 1.2, helm: 1.2, body: 1.17, gloves: 1.2, boots: 1.18, belt: 1.08, ring: 1.3, amulet: 1.1 };
  const ITEM_DRAW = {
    // 按基底的 type 选画法（数据里没写 type 的老基底按下标 0 / 1 / 2 退回刃 / 长杖 / 短杖）
    weapon: (g, base, tier) => (WEAPON_DRAW[weaponType(base)] || drawBlade)(g, tier),
    helm: (g, base, tier) => drawHelm(g, tier),
    body: (g, base, tier) => drawBody(g, tier),
    gloves: (g, base, tier) => drawGloves(g, tier),
    boots: (g, base, tier) => drawBoots(g, tier),
    belt: (g, base, tier) => drawBelt(g, tier),
    ring: (g, base) => drawRing(g, base),
    amulet: (g, base) => drawAmulet(g, base),
  };

  // =====================================================================
  // 通货：两种尘是一小堆，五种石各有轮廓与刻纹
  // =====================================================================
  const CUR_DRAW = {
    dust(g, col) {
      solid(g, (p) => p.M(-23, 18).Q(-16, 1, -4, 0).Q(2, -6, 9, 1).Q(19, 4, 23, 18).Z(), col, { hi: 0.4 });
      line(g, (p) => p.M(-12, 11).L(-11, 11.4).M(-3, 8).L(-2, 8.4).M(5, 12).L(6, 12.4).M(12, 10).L(13, 10.4).M(-6, 14).L(-5, 14.2).M(0, 13).L(1, 13.2), rgba('#ffffff', 0.75), 1.5);
      spark(g, -10, -13, 8, col);
      spark(g, 9, -19, 5.4, col);
      spark(g, 15, -7, 3.8, col);
    },
    augment(g, col) {
      solid(g, (p) => p.M(-20, 19).Q(-12, 8, 0, 9).Q(13, 8, 20, 19).Z(), dark(col, 0.25), { hi: 0.3 });
      // 一大一小两枚晶片
      solid(g, (p) => p.P([8, -3, 15.5, 4, 12.6, 14.5, 5.2, 13]), dark(col, 0.1), { hi: 0.4 });
      glow(g, (p) => p.P([-4, -25, 5, -12, 2.4, 13, -9, 13.5, -11.6, -11]), col, { blur: 7, core: col });
      solid(g, (p) => p.P([-4, -25, 5, -12, 2.4, 13, -9, 13.5, -11.6, -11]), col, { hi: 0.55 });
      line(g, (p) => p.M(-4, -25).L(-3, 13).M(-11.6, -11).L(-3.6, -8).L(5, -12), rgba('#ffffff', 0.5), 1);
      spark(g, 13.5, -15, 5.4, col);
    },
    alch(g, col) {
      glow(g, (p) => p.P([-16, -4, -6, -17, 9, -18, 19, -5, 16, 12, 2, 20, -14, 13]), col, { blur: 6, core: col });
      solid(g, (p) => p.P([-16, -4, -6, -17, 9, -18, 19, -5, 16, 12, 2, 20, -14, 13]), col, { hi: 0.5 });
      line(g, (p) => p.M(-6, -17).L(-2, -3).L(19, -5).M(-2, -3).L(-14, 13).M(-2, -3).L(2, 20).M(-16, -4).L(-2, -3), dark(col, 0.42), 1.2);
      line(g, (p) => p.M(-4.6, -14.5).L(-1.2, -4.6).M(1, -4.4).L(15.4, -5.8), rgba('#ffffff', 0.6), 1);
      spark(g, 10.5, -13, 6, '#fff3c0');
    },
    regal(g, col) {
      // 石身 + 冠齿
      solid(g, (p) => p.P([-17, -3, -18.5, -19, -9.5, -10, 0, -24, 9.5, -10, 18.5, -19, 17, -3, 14, 15, 0, 21, -14, 15]), col, { hi: 0.42 });
      solid(g, (p) => p.M(-17.4, -3.4).L(17.4, -3.4).L(16.6, 2).L(-16.6, 2).Z(), dark(col, 0.25), { bevel: 1.1, lw: 1.7 });
      for (const x of [-10, 0, 10]) gem(g, x, -0.7, 2.1, x ? '#fff0c4' : '#ff5a4a', 4, null, { glow: 3, lw: 1.1 });
      line(g, (p) => p.M(-10, 6).L(-6, 15).M(10, 6).L(6, 15).M(0, 5).L(0, 18), dark(col, 0.4), 1.1);
      spark(g, 0, -24, 4.4, '#fff3c0');
    },
    exalt(g, col) {
      glow(g, (p) => p.P([0, -27, 10.5, -6, 6, 19, -6, 19, -10.5, -6]), col, { blur: 8, core: col });
      solid(g, (p) => p.P([0, -27, 10.5, -6, 6, 19, -6, 19, -10.5, -6]), col, { hi: 0.6, lo: 0.4 });
      line(g, (p) => p.M(0, -27).L(0, 19).M(-10.5, -6).L(0, -1).L(10.5, -6), dark(col, 0.45), 1.1);
      // 向上的三道升势
      line(g, (p) => p.M(-19, 4).L(-15, -2).L(-11.6, 3).M(11.6, 3).L(15, -2).L(19, 4).M(-20, 14).L(-15.6, 8).L(-12, 13).M(12, 13).L(15.6, 8).L(20, 14), lite(col, 0.3), 1.8);
      spark(g, 0, -27, 5.4, '#ffffff');
    },
    chaos(g, col) {
      solid(g, (p) => p.M(-17, -8).Q(-10, -22, 4, -20).Q(19, -17, 19, -2).Q(20, 13, 7, 19).Q(-9, 23, -17, 11).Q(-22, 2, -17, -8).Z(), dark(col, 0.2), { hi: 0.3 });
      glow(g, (p) => p.M(1.4, 1).C(-4.6, -3, 0, -9.6, 6, -6.4).C(13, -2.6, 10.6, 9.4, 1, 10.4).C(-10.4, 11.6, -14, -3.6, -6, -11).C(-1, -15.6, 7, -15.6, 11.6, -12.4), col, { stroke: 1.9, blur: 5, core: lite(col, 0.6) });
      line(g, (p) => p.M(13, 9).L(17, 13.4).M(-13, 10).L(-9, 16).M(-15, -5).L(-19, -1), dark(col, 0.6), 1.2);
    },
    divine(g, col) {
      solid(g, (p) => p.P([-12, -19, 12, -19, 20, -6, 14, 17, -14, 17, -20, -6]), col, { hi: 0.42 });
      solid(g, (p) => p.E(0, -1.4, 12.2), dark(col, 0.3), { bevel: 1.3, lw: 1.6 });
      // 首尾相追的两道弧：重掷
      const arr = (a0, m) => {
        glow(g, (p) => { for (let i = 0; i <= 10; i++) { const a = a0 + (i / 10) * 2.2; p[i ? 'L' : 'M'](Math.cos(a) * 7.4, -1.4 + Math.sin(a) * 7.4); } }, col, { stroke: 1.9, blur: 4, core: '#fff2f5', m });
        const a = a0 + 2.2, x = Math.cos(a) * 7.4, y = -1.4 + Math.sin(a) * 7.4, tx = -Math.sin(a), ty = Math.cos(a);
        glow(g, (p) => p.P([x + tx * 4, y + ty * 4, x - ty * 3.2, y + tx * 3.2, x + ty * 3.2, y - tx * 3.2]), col, { blur: 3, core: '#fff2f5', m });
      };
      arr(-2.6);
      arr(-2.6 + Math.PI);
    },
    // 琢刻石：一块削开一面的晶石，一把刻刀斜着抵在切口上，崩出一片碎晶
    chisel(g, col) {
      const stone = [-24, 4, -16, -9, -5, -13, 6, -5, 7, 12, -5, 22, -19, 18];
      glow(g, (p) => p.P(stone), col, { blur: 6, core: col });
      solid(g, (p) => p.P(stone), col, { hi: 0.45 });
      line(g, (p) => p.M(-1, 0).L(-6, 21).M(-1, 0).L(-22, 7).M(-1, 0).L(6, 11).M(-12, -4).L(-16, -9), dark(col, 0.42), 1.1);
      // 削开的那一面：更亮的平切面
      solid(g, (p) => p.P([-5, -13, 6, -5, -1, 0, -12, -4]), lite(col, 0.55), { hi: 0.5, lo: 0.12, bevel: 1.1, lw: 1.6 });
      line(g, (p) => p.M(-10.4, -4.6).L(-4.6, -11), rgba('#ffffff', 0.85), 1.2);
      // 崩出去的碎晶
      solid(g, (p) => p.P([9, -12, 14.5, -15, 13.4, -8.6]), lite(col, 0.25), { hi: 0.6, bevel: 0.8, lw: 1.4 });
      // 刻刀：木柄、铁箍、扁刃，刃口落在切面的边上
      const m = rot(45, 0.88, 8.6, -12.6);
      tube(g, (p) => p.M(0, -19).L(0, -6.5), '#9a6a3e', 6.4, { m });
      solid(g, (p) => p.R(-4.3, -7.6, 8.6, 3.8, 0.8), C.ironD, { m, hi: 0.5, bevel: 0.9, lw: 1.6 });
      solid(g, (p) => p.P([-2.6, -3.8, 2.6, -3.8, 3.5, 8, 3.5, 10.6, -3.5, 10.6, -3.5, 8]), C.steel, { m, hi: 0.55, lo: 0.35, bevel: 1, lw: 1.7 });
      line(g, (p) => p.M(-3.3, 8).L(3.3, 8), dark(C.steel, 0.35), 1, m);
      line(g, (p) => p.M(-1, -3).L(-1.6, 7.4), rgba('#ffffff', 0.7), 1, m);
      spark(g, 2.4, -5.4, 6.4, '#ffffff');
    },
  };

  // =====================================================================
  // 技能：亮色主体 + 元素色辉光，底板由界面的格子提供
  // =====================================================================
  const SKILL_DRAW = {
    // 裂石击：一道新月形斩痕
    cleave(g, col) {
      const cres = (p, r0, r1, a0, a1, off) => {
        for (let i = 0; i <= 16; i++) { const a = a0 + ((a1 - a0) * i) / 16; p[i ? 'L' : 'M'](Math.cos(a) * r0, Math.sin(a) * r0); }
        for (let i = 16; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / 16; p.L(Math.cos(a) * r1 + off, Math.sin(a) * r1 + off); }
        return p.Z();
      };
      const m = rot(0, 1, -5, 5);
      glow(g, (p) => cres(p, 24, 19, -2.2, 0.55, 7.5), col, { m, blur: 8, core: col });
      solid(g, (p) => cres(p, 24, 19, -2.2, 0.55, 7.5), lite(col, 0.55), { m, hi: 0.6, lo: 0.3 });
      line(g, (p) => p.M(-14, 8).L(-4, -1).M(-8, 16).L(4, 5).M(0, 20).L(8, 13), rgba('#ffffff', 0.75), 1.6, m);
      spark(g, 17, 8, 5, '#ffffff');
    },
    // 掷焰：拖着尾焰的火球
    ember(g, col) {
      const m = rot(-48, 1.02, 2, -2);
      const flame = (p, k) => p.M(0, -25 * k).C(9 * k, -13 * k, 16 * k, -4 * k, 12.5 * k, 8 * k).C(9 * k, 19 * k, -9 * k, 19 * k, -12.5 * k, 8 * k).C(-16 * k, -1 * k, -7 * k, -5 * k, -6.5 * k, -13 * k).C(-3 * k, -9 * k, -2 * k, -17 * k, 0, -25 * k).Z();
      glow(g, (p) => flame(p, 1), col, { m, blur: 9, core: col });
      solid(g, (p) => flame(p, 1), col, { m, hi: 0.3, lo: 0.35 });
      solid(g, (p) => flame(p, 0.6), '#ffd27a', { m: rot(-48, 1.02, -1.2, 1.4), hi: 0.6, lo: 0.1, lw: 0, bevel: 0 });
      glow(g, (p) => p.E(0, 5, 4.2), '#ffffff', { m: rot(-48, 1.02, -1.2, 1.4), blur: 4, core: '#fffbe6' });
      glow(g, (p) => p.E(15, -17, 2).E(21, -9, 1.4).E(9, -23, 1.3), col, { blur: 3, core: '#ffd27a' });
    },
    // 飞刃：三片弯刃的回旋镖
    blade(g, col) {
      for (let i = 0; i < 3; i++) {
        const m = rot(i * 120 + 14, 1, 0, 0);
        solid(g, (p) => p.M(-2.6, -3).Q(3, -15, -5, -26).Q(14, -20, 8.4, -1.6).Z(), lite(col, 0.25), { m, hi: 0.6 });
        line(g, (p) => p.M(1.6, -5).Q(5.6, -14, 1.4, -21), rgba('#28303c', 0.6), 1, m);
      }
      solid(g, (p) => p.E(0, 0, 5.6).E(0, 0, 2.2), dark(col, 0.3), { rule: 'evenodd', bevel: 1.2, lw: 1.9 });
      line(g, (p) => { for (let i = 0; i <= 8; i++) { const a = 0.5 + (i / 8) * 1.1; p[i ? 'L' : 'M'](Math.cos(a) * 26, Math.sin(a) * 26); } for (let i = 0; i <= 8; i++) { const a = 3.7 + (i / 8) * 0.9; p[i ? 'L' : 'M'](Math.cos(a) * 26.5, Math.sin(a) * 26.5); } }, rgba('#ffffff', 0.7), 1.5);
    },
    // 霜环：一圈向外的冰棱
    nova(g, col) {
      glow(g, (p) => p.E(0, 0, 13), col, { stroke: 4, blur: 8, core: col });
      for (let i = 0; i < 8; i++) {
        const big = i % 2 === 0;
        const m = rot(i * 45, 1, 0, 0);
        solid(g, (p) => p.P([0, big ? -27 : -22, big ? 4.4 : 3.4, -12, 0, -9, big ? -4.4 : -3.4, -12]), lite(col, big ? 0.5 : 0.25), { m, hi: 0.7, lo: 0.3, lw: 1.9, bevel: 1.1 });
      }
      solid(g, (p) => p.E(0, 0, 12.4).E(0, 0, 7.4), lite(col, 0.35), { rule: 'evenodd', hi: 0.6, bevel: 1.3, lw: 1.9 });
      spark(g, 0, 0, 6.4, '#ffffff');
    },
    // 链雷：分叉的闪电与两端的落点
    arc(g, col) {
      const bolt = (p) => p.P([-19, -24, -3, -11, -9, -6, 9, 5, 2, 8, 20, 25, -1, 12, 5, 8.6, -12, -1.4, -5.4, -6]);
      glow(g, bolt, col, { blur: 9, core: col });
      solid(g, bolt, lite(col, 0.5), { hi: 0.7, lo: 0.15, bevel: 1.1, lw: 2 });
      glow(g, (p) => p.M(4, 1.6).L(14, -3).L(11.6, -8.6).L(22, -14), col, { stroke: 1.9, blur: 5, core: '#fffbe0' });
      glow(g, (p) => p.M(-6, 3).L(-13, 10).L(-10.6, 15).L(-18, 21), col, { stroke: 1.5, blur: 5, core: '#fffbe0' });
      spark(g, 22, -14, 4.6, '#ffffff');
      spark(g, -19, 22, 3.8, '#ffffff');
    },
    // 陨火：带着火尾砸下来的石头
    meteor(g, col) {
      const m = rot(0, 1, 0, 0);
      const tail = (p) => p.M(-17, 3).C(-6, -10, 10, -22, 27, -28).C(18, -15, 11, -3, 1.4, 14).Z();
      glow(g, tail, col, { m, blur: 9, core: col });
      solid(g, tail, col, { m, hi: 0.35, lo: 0.2, lw: 2 });
      solid(g, (p) => p.M(-9, 3).C(0, -6, 10, -14, 20, -20).C(13, -10, 7, -2, -1, 9).Z(), '#ffd27a', { m, hi: 0.5, lo: 0, lw: 0, bevel: 0 });
      solid(g, (p) => p.P([-20, 3, -11, -4, -1, 0, 3.4, 10, -1, 20, -12, 23, -21, 16, -23.4, 8]), '#5a3a34', { m, hi: 0.22, lo: 0.5 });
      glow(g, (p) => p.M(-17, 8).L(-11, 9).L(-9, 15).M(-11, 9).L(-6, 4.6).M(-14, 18).L(-9, 15).L(-3.6, 16), col, { m, stroke: 1.3, blur: 4, core: '#ffd27a' });
      line(g, (p) => p.M(-27, 25).L(-17, 27.4).M(-5, 27).L(6, 24), rgba(col, 0.8), 1.6);
    },
    // 闪袭：一道突进的残影，尽头亮起
    blink(g, col) {
      const m = rot(-40, 1, 0, 0);
      line(g, (p) => p.M(-27, -7).L(-12, -7).M(-28, 7).L(-10, 7).M(-24, 0).L(-15, 0), rgba(lite(col, 0.4), 0.85), 1.7, m);
      for (let i = 0; i < 3; i++) {
        const x = -12 + i * 10, k = 0.7 + i * 0.22;
        const chev = (p) => p.P([x - 4 * k, -11 * k, x + 2 * k, -11 * k, x + 10 * k, 0, x + 2 * k, 11 * k, x - 4 * k, 11 * k, x + 4 * k, 0]);
        if (i === 2) glow(g, chev, col, { m, blur: 9, core: col });
        solid(g, chev, i === 2 ? lite(col, 0.6) : mix(col, '#2a2040', 0.55 - i * 0.25), { m, hi: 0.5, lo: 0.3, lw: 1.9, bevel: 1.1 });
      }
      spark(g, 19, -16.4, 6.4, '#ffffff');
    },
    // 旋风斩：三道首尾相追的弧形刃光绕着中心转，外圈甩出几道风痕
    whirl(g, col) {
      // 一道新月形的刃光：外沿从 a0 扫到 a1、半径由 r0 收到 r1，内沿稍细
      const blade = (p, a0, a1, r0, r1, w) => {
        const N = 14;
        for (let i = 0; i <= N; i++) { const f = i / N, a = a0 + (a1 - a0) * f, r = r0 + (r1 - r0) * f; p[i ? 'L' : 'M'](Math.cos(a) * r, Math.sin(a) * r); }
        for (let i = N; i >= 0; i--) { const f = i / N, a = a0 + (a1 - a0) * f, r = r0 + (r1 - r0) * f - w * Math.sin(f * Math.PI); p.L(Math.cos(a) * r, Math.sin(a) * r); }
        return p.Z();
      };
      glow(g, (p) => p.E(0, 0, 17), col, { stroke: 3, blur: 9, core: col });
      for (let i = 0; i < 3; i++) {
        const a0 = (i * TAU) / 3 - 0.3;
        glow(g, (p) => blade(p, a0, a0 + 1.9, 26, 9, 6.5), col, { blur: 6, core: col });
        solid(g, (p) => blade(p, a0, a0 + 1.9, 26, 9, 6.5), lite(col, 0.45), { hi: 0.7, lo: 0.25, lw: 1.8, bevel: 1.1 });
        line(g, (p) => { for (let k = 0; k <= 8; k++) { const f = k / 8, a = a0 + 0.15 + 1.4 * f, r = 24.4 - 11 * f; p[k ? 'L' : 'M'](Math.cos(a) * r, Math.sin(a) * r); } }, rgba('#ffffff', 0.7), 1.2);
      }
      // 外圈的风痕
      line(g, (p) => { for (const a0 of [0.9, 3.0, 5.1]) for (let k = 0; k <= 6; k++) { const a = a0 + k * 0.09; p[k ? 'L' : 'M'](Math.cos(a) * 28, Math.sin(a) * 28); } }, rgba(lite(col, 0.3), 0.75), 1.5);
      solid(g, (p) => p.E(0, 0, 6.2).E(0, 0, 2.6), dark(col, 0.25), { rule: 'evenodd', bevel: 1.2, lw: 1.8 });
      spark(g, 0, 0, 5.6, '#ffffff');
    },
    // 影步连斩：一柄朝左上斜指的直刃，往右上错开两道越来越小、越来越淡的影子（一闪一闪地换位），刃尖亮起
    shadestep(g, col) {
      const blade = (p) => p.P([0, -27, 3.3, -21, 3.3, 3, -3.3, 3, -3.3, -21]);
      const hilt = (p) => p.R(-8.6, 3, 17.2, 3.6, 1.6).R(-2, 6.6, 4, 7.8, 1).E(0, 16.6, 2.5);
      const A = -40, ca = Math.cos((A * Math.PI) / 180), sa = Math.sin((A * Math.PI) / 180);
      // 剑身中点（局部 (0, -4)）落在 (qx, qy)，缩放 k
      const at = (qx, qy, k) => rot(A, k, qx - 4 * k * sa, qy + 4 * k * ca);
      const qx = -3.5, qy = 3;
      // 影子：暗色剪影，边上透出一点本色的光
      for (const [d, k, a] of [[23, 0.64, 0.42], [12.5, 0.8, 0.7]]) {
        const m = at(qx + ca * d, qy + sa * d, k);
        g.save();
        g.globalAlpha = a;
        glow(g, blade, col, { m, blur: 6, core: dark(col, 0.1) });
        solid(g, (p) => { blade(p); return hilt(p); }, mix(col, '#141226', 0.6), { m, hi: 0.35, lo: 0.3, bevel: 0, lw: 1.5 });
        g.restore();
      }
      const k = 0.94, m = at(qx, qy, k);
      glow(g, blade, col, { m, blur: 9, core: col });
      solid(g, blade, lite(col, 0.6), { m, hi: 0.7, lo: 0.25, lw: 2, bevel: 1.1 });
      line(g, (p) => p.M(0, -20).L(0, 0.5), rgba(dark(col, 0.5), 0.7), 1.2, m);
      solid(g, hilt, dark(col, 0.35), { m, hi: 0.4, lo: 0.4, lw: 1.9, bevel: 1 });
      // 刃尖：局部 (0, -27)
      spark(g, qx + 23 * k * sa, qy - 23 * k * ca, 6, '#ffffff');
    },
    // 烬骸仆从：一颗骷髅，眼窝里是青色的魂火；身后斜插一柄带缺口的剑，左下挂一面小圆盾
    thrall(g, col) {
      // 魂火的底光：让骷髅一眼看上去是「自己人」
      glow(g, (p) => p.E(-3, 1, 13), ALLY, { blur: 10, core: rgba(ALLY, 0.18) });
      // 剑：剑柄藏在骷髅后面，刃从右上方伸出来，刃口两处缺口
      const m = rot(45, 1, 7, -7);
      solid(g, (p) => p.P([-3.2, 8, -3.2, -16, 0, -24, 3.2, -16, 3.2, -11, 1.2, -9.4, 3.2, -7.6, 3.2, -1, 1.4, 0.6, 3.2, 2.2, 3.2, 8]), C.steel, { m, hi: 0.55, lo: 0.4, bevel: 1.1, lw: 2 });
      line(g, (p) => p.M(-0.6, -20).L(-0.6, 6), rgba('#ffffff', 0.6), 1, m);
      solid(g, (p) => p.R(-8.4, 8, 16.8, 3.8, 1.4), C.copper, { m, hi: 0.4, bevel: 1, lw: 1.8 });
      // 小圆盾：左下，被骷髅压住一角
      solid(g, (p) => p.E(-16, 15, 10), C.ironD, { hi: 0.35, lo: 0.5, bevel: 1.3, lw: 2 });
      solid(g, (p) => p.E(-16, 15, 10).E(-16, 15, 7.2), C.copper, { rule: 'evenodd', hi: 0.4, bevel: 0.9, lw: 1.5 });
      solid(g, (p) => p.E(-16, 15, 2.6), C.iron, { bevel: 0.8, lw: 1.4 });
      // 骷髅：头盖骨 + 颧骨 + 下颌
      const skull = (p) => p.M(-14, 1).C(-17, -22, 13, -22, 10, 1).L(8.6, 6.6).L(4.4, 8.2).L(4, 14.6).L(-8.4, 14.6).L(-8.8, 8.2).L(-12.6, 6.6).Z();
      solid(g, skull, C.bone, { hi: 0.4, lo: 0.42, bevel: 1.5, lw: 2.2 });
      // 眼窝与魂火
      solid(g, (p) => p.E(-7.6, -1.6, 4.2, 3.8).E(3.8, -1.6, 4.2, 3.8), '#241812', { hi: 0.1, lo: 0.3, bevel: 0, lw: 1.3 });
      glow(g, (p) => p.E(-7.2, -1.4, 2.2).E(4.2, -1.4, 2.2), ALLY, { blur: 7, core: '#e2fff8' });
      // 鼻孔与牙
      solid(g, (p) => p.P([-1.9, 2.8, 0, 6.8, -3.8, 6.8]), '#241812', { bevel: 0, lw: 1 });
      line(g, (p) => p.M(-5.6, 9.8).L(-5.6, 14).M(-2, 9.8).L(-2, 14.2).M(1.6, 9.8).L(1.6, 14).M(-8, 10).L(4, 10), rgba('#3a2a1c', 0.85), 1.1);
      // 头盖骨上的一道裂纹
      line(g, (p) => p.M(-9, -15.6).L(-6.6, -11).L(-8.8, -8.6).L(-7, -5.6), rgba('#5a4630', 0.8), 1.1);
      spark(g, 22.6, -21.6, 4.6, col === ALLY ? '#ffffff' : lite(col, 0.4));
    },
    // 焚骨祭司：兜帽下的骷髅，眼窝里是青色的魂火；右边竖着一根骨木长杖，杖头铁笼里关着一团焚火，火舌往上蹿
    pyre(g, col) {
      const FIRE = C.ember, robe = '#3b2e2a', robeL = '#5a4640', robeD = '#1c1412';
      // 杖头的火光先铺底：让整枚图标带着暖色
      glow(g, (p) => p.E(15, -17, 12), FIRE, { blur: 12, core: rgba(FIRE, 0.22) });
      glow(g, (p) => p.E(-4, 2, 13), ALLY, { blur: 10, core: rgba(ALLY, 0.14) });
      // 长杖：从右下竖到右上，两道铜箍
      tube(g, (p) => p.M(14, 28).Q(16.6, 8, 15, -10), C.woodD, 3.2);
      line(g, (p) => p.M(14.6, 24).Q(16.4, 8, 15.2, -6), rgba(C.wood, 0.8), 1);
      solid(g, (p) => p.R(12.2, 4, 6.4, 2.6, 1).R(12.4, 14, 6.2, 2.6, 1), C.copper, { hi: 0.45, bevel: 0.7, lw: 1.4 });
      // 铁笼里的焚火
      const flame = (p, k, x, y) => p.M(x, y - 14 * k).C(x + 5 * k, y - 7 * k, x + 8.5 * k, y - 2 * k, x + 6.5 * k, y + 4 * k).C(x + 4.6 * k, y + 9.4 * k, x - 4.6 * k, y + 9.4 * k, x - 6.5 * k, y + 4 * k).C(x - 8.5 * k, y - 1 * k, x - 3.4 * k, y - 3.4 * k, x - 3 * k, y - 7.4 * k).C(x - 1.4 * k, y - 5 * k, x - 1 * k, y - 9.6 * k, x, y - 14 * k).Z();
      glow(g, (p) => flame(p, 1.25, 15, -19), FIRE, { blur: 9, core: FIRE });
      solid(g, (p) => flame(p, 1.25, 15, -19), FIRE, { hi: 0.35, lo: 0.3, lw: 1.6, bevel: 0.6 });
      solid(g, (p) => flame(p, 0.7, 15, -16.6), '#ffd27a', { hi: 0.6, lo: 0.1, lw: 0, bevel: 0 });
      glow(g, (p) => p.E(15, -14.4, 2.6), '#ffffff', { blur: 4, core: '#fffbe6' });
      line(g, (p) => p.M(15, -9.6).Q(7.6, -16, 11, -26).M(15, -9.6).Q(22.4, -16, 19, -26).M(15, -9.6).L(15, -27.4), rgba(C.ironD, 0.95), 1.9);
      solid(g, (p) => p.E(15, -28.4, 3), C.bone, { hi: 0.4, bevel: 0.8, lw: 1.4 });
      // 兜帽与法袍：焦黑的布，下摆烧得参差
      const hood = (p) => p.M(-21, 27).L(-19.6, 6).C(-21, -12, -14, -25.6, -3.4, -25.6).C(7.4, -25.6, 13.4, -13, 11.6, 6).L(12.6, 27).L(7, 23.6).L(3, 27.4).L(-2.6, 23).L(-7.6, 27.4).L(-12.4, 23.4).L(-16.6, 27.4).Z();
      solid(g, hood, robe, { hi: 0.32, lo: 0.5, bevel: 1.4, lw: 2.2 });
      line(g, (p) => p.M(-12.6, 9).Q(-15, 18, -14, 24).M(5.4, 9.6).Q(7, 18, 6, 23), rgba(robeL, 0.9), 1.2);
      // 下摆破口里的余烬
      glow(g, (p) => p.E(-9.6, 24.6, 1.4).E(0.6, 25, 1.2).E(9.4, 24.4, 1.1), FIRE, { blur: 4, core: '#ffd27a' });
      // 兜帽里的阴影和骷髅脸
      solid(g, (p) => p.M(-14, 6).C(-15.6, -9, -10, -19.4, -3.4, -19.4).C(3.4, -19.4, 8.4, -9, 7, 6).Q(-3.4, 10, -14, 6).Z(), robeD, { hi: 0.05, lo: 0.3, bevel: 0, lw: 1.4 });
      const skull = (p) => p.M(-11, -3).C(-12.6, -18, 6, -18, 4.6, -3).L(3.4, 1.4).L(0.6, 2.6).L(0.4, 7.4).L(-7, 7.4).L(-7.2, 2.6).L(-10, 1.4).Z();
      solid(g, skull, C.bone, { hi: 0.4, lo: 0.42, bevel: 1.2, lw: 1.9 });
      solid(g, (p) => p.E(-6.6, -5, 3.2, 2.9).E(0.4, -5, 3.2, 2.9), '#241812', { hi: 0.1, lo: 0.3, bevel: 0, lw: 1.1 });
      glow(g, (p) => p.E(-6.4, -4.8, 1.7).E(0.6, -4.8, 1.7), ALLY, { blur: 6, core: '#e2fff8' });
      solid(g, (p) => p.P([-3, -1.6, -1.6, 1.4, -4.4, 1.4]), '#241812', { bevel: 0, lw: 0.9 });
      line(g, (p) => p.M(-5, 3.6).L(-5, 7).M(-3, 3.6).L(-3, 7.2).M(-1, 3.6).L(-1, 7), rgba('#3a2a1c', 0.85), 1);
      // 胸前一串骨珠
      for (let i = 0; i < 5; i++) solid(g, (p) => p.E(-12 + i * 4.4, 12.6 + Math.abs(i - 2) * -0.9, 1.7), i % 2 ? C.bone : C.boneD, { hi: 0.4, bevel: 0.5, lw: 1 });
      // 左手托着的一小簇火
      glow(g, (p) => flame(p, 0.45, -21, 14), FIRE, { blur: 5, core: '#ffd27a' });
      solid(g, (p) => p.E(-21, 17.4, 3.2, 2), C.bone, { hi: 0.4, bevel: 0.6, lw: 1.2 });
    },
    // 石誓守像：圆石垒成的宽肩、缩在两肩之间的方头、胸口一道发光的誓印、两只巨石拳头
    colossus(g, col) {
      const st = C.stone, stL = mix(C.stone, '#d8d0c2', 0.22), stD = mix(C.stone, '#3e3a36', 0.3);
      // 手臂：从肩头垂到拳头
      tube(g, (p) => p.M(-15, -8).Q(-21, 2, -19.6, 10), stD, 7);
      tube(g, (p) => p.M(15, -8).Q(21, 2, 19.6, 10), stD, 7);
      // 躯干
      solid(g, (p) => p.P([-12.6, -15, 12.6, -15, 14.6, 3, 8.6, 17.6, -8.6, 17.6, -14.6, 3]), st, { hi: 0.32, lo: 0.5, bevel: 1.6, lw: 2.2 });
      line(g, (p) => p.M(-12.4, 6).L(-6, 8.6).M(6.4, 9.4).L(12.2, 5.4).M(-1.6, 17.4).L(-0.6, 12.6), rgba('#34302c', 0.85), 1.1);
      // 方头：缩在两肩之间，眉骨下透出青光
      solid(g, (p) => p.P([-6.4, -25.6, 6.4, -25.6, 7.4, -15, -7.4, -15]), stD, { hi: 0.4, lo: 0.45, bevel: 1.2, lw: 2 });
      solid(g, (p) => p.P([-7.6, -21.4, 7.6, -21.4, 7, -19, -7, -19]), mix(stD, '#000000', 0.2), { bevel: 0, lw: 1.2 });
      glow(g, (p) => p.R(-4.6, -18.6, 9.2, 2, 1), ALLY, { blur: 5, core: '#e2fff8' });
      // 青铜护颈
      solid(g, (p) => p.M(-9, -15.6).Q(0, -10.6, 9, -15.6).L(8, -12.4).Q(0, -7.8, -8, -12.4).Z(), C.copper, { hi: 0.45, lo: 0.45, bevel: 1, lw: 1.7 });
      // 肩头两块圆石
      for (const s of [-1, 1]) {
        solid(g, (p) => p.P([s * 7.6, -14, s * 11, -19, s * 18, -19.4, s * 22.6, -14.4, s * 22, -7, s * 16.6, -3.6, s * 10, -6]), stL, { hi: 0.45, lo: 0.5, bevel: 1.4, lw: 2.1 });
        line(g, (p) => p.M(s * 12.4, -15.4).L(s * 16.6, -11.6), rgba('#34302c', 0.8), 1.1);
      }
      // 胸口誓印：圆环 + 竖线 + 菱形
      glow(g, (p) => p.E(0, 2.8, 6.2), ALLY, { stroke: 1.9, blur: 7, core: '#c9fff2' });
      glow(g, (p) => p.M(0, -3.6).L(0, 9.4), ALLY, { stroke: 1.5, blur: 5, core: '#c9fff2' });
      glow(g, (p) => p.P([0, -0.4, 3, 2.8, 0, 6, -3, 2.8]), ALLY, { blur: 6, core: '#f2fffb' });
      // 两只巨石拳头 + 青铜腕箍
      for (const s of [-1, 1]) {
        const x = 19.6 * s;
        solid(g, (p) => p.R(x - 6.4, 6.4, 12.8, 3.6, 1.2), C.copper, { hi: 0.45, bevel: 0.8, lw: 1.6 });
        solid(g, (p) => p.P([x - 8.6, 12, x - 4.6, 9.4, x + 4.6, 9.4, x + 9.4, 13, x + 9.4, 21, x + 4.6, 25.4, x - 4.6, 25.4, x - 9.4, 20.6]), stL, { hi: 0.45, lo: 0.5, bevel: 1.4, lw: 2.1 });
        line(g, (p) => p.M(x - 6, 15.4).L(x + 6, 15.4).M(x - 6.4, 19.6).L(x + 6.4, 19.6).M(x - 0.6, 10).L(x - 0.6, 15.2), rgba('#34302c', 0.85), 1.1);
      }
      if (col !== ALLY) spark(g, 0, -27, 3.8, lite(col, 0.4));
    },
  };

  // =====================================================================
  // 武器技：按武器类型画（技能 id 由数据决定，图标跟着 G.BASES.weapon[i].wskill 找到类型）
  // =====================================================================
  const WSKILL_COLOR = {
    blade: '#f0e2c4', staff: '#c79bff', wand: '#9fd0ff', daggers: '#b58cff', hammer: '#e8b070', bow: '#a8e08a', katana: '#ff9a7a', banner: ALLY,
    gatling: '#ffb36a', flamer: '#ff6a2c', revolver: '#ffcf7a', huntbow: '#bfe8a0', eagle: '#e8f4ff', runebow: '#c9a6ff', emberbow: '#9fd8ff',
  };
  // 一支箭（尖朝 -y，长约 30）：箭杆、箭羽、箭镞；col 是箭镞 / 光的颜色
  function arrowAt(g, m, col, o) {
    o = o || {};
    if (o.trail) line(g, (p) => p.M(0, 10).L(0, 10 + o.trail), rgba(lite(col, 0.4), 0.6), 1.5, m);
    tube(g, (p) => p.M(0, 11).L(0, -9), o.shaft || C.woodD, 1.5, { m });
    solid(g, (p) => p.M(0, 8).L(-3, 12).L(-3, 14).L(0, 11.4).L(3, 14).L(3, 12).Z(), o.fletch || C.bone, { m, bevel: 0, lw: 1.1 });
    glow(g, (p) => p.P([0, -16, 3, -8, 0, -9.6, -3, -8]), col, { m, blur: o.blur || 5, core: lite(col, 0.55) });
    solid(g, (p) => p.P([0, -16, 3, -8, 0, -9.6, -3, -8]), lite(col, 0.35), { m, bevel: 0, lw: 1.2 });
  }
  const WSKILL_DRAW = {
    // 熔光射线：枪口（左下）喷出一道粗光束斜贯到右上，外焰橙红、芯白热，一路缠着电弧，落点炸开
    gatling(g, col) {
      const m = rot(-45, 1, 0, 0);
      glow(g, (p) => p.M(-5, 26).L(-6.5, -30).L(6.5, -30).L(5, 26).Z(), '#ff6a2c', { m, blur: 10, core: rgba('#ff7a2c', 0.75) });
      glow(g, (p) => p.M(-2.4, 26).L(-3, -30).L(3, -30).L(2.4, 26).Z(), col, { m, blur: 6, core: lite(col, 0.4) });
      solid(g, (p) => p.M(-1, 26).L(-1.2, -30).L(1.2, -30).L(1, 26).Z(), '#fffbe8', { m, hi: 0, lo: 0, lw: 0, bevel: 0 });
      glow(g, (p) => p.M(-6, 18).L(4, 12).L(-5, 4).L(5, -4).L(-4, -12).L(6, -20).L(-3, -27), C.light, { m, stroke: 1.3, blur: 4, core: '#fff6c0' });
      glow(g, (p) => p.E(19, -19, 7), col, { blur: 10, core: lite(col, 0.6) });
      solid(g, (p) => p.R(-26, 15, 12, 8, 2), C.ironD, { m: rot(-45, 1, 0, 0), bevel: 1, lw: 1.6 });
      spark(g, 19, -19, 7, '#ffffff');
    },
    // 焚天炎爆：中心一团白热，一圈往外翻卷的火浪，地上一圈烧红的焦痕
    flamer(g, col) {
      const ky = 0.5;
      glow(g, (p) => p.E(0, 6, 26, 26 * ky), '#7a2008', { stroke: 4, blur: 8, core: rgba('#c2401a', 0.8) });
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU + 0.3, x = Math.cos(a) * 19, y = 6 + Math.sin(a) * 19 * ky, k = 0.8 + (i % 3) * 0.15;
        const tr = (p) => p.M(x - 4 * k, y + 2).C(x - 5 * k, y - 6 * k, x - 1, y - 9 * k, x + 1 * k, y - 15 * k).C(x + 2, y - 9 * k, x + 5 * k, y - 6 * k, x + 4 * k, y + 2).Z();
        glow(g, tr, col, { blur: 5, core: rgba(lite(col, 0.3), 0.85) });
        solid(g, tr, lite(col, 0.35), { hi: 0.7, lo: 0.2, lw: 1.3, bevel: 0 });
      }
      glow(g, (p) => p.E(0, 4, 9, 8), '#ffd08a', { blur: 12, core: '#fff4dc' });
      spark(g, 0, 2, 9, '#ffffff');
    },
    // 万矢：一支箭在中间裂成五支追踪箭，各自拐着弯扑向右上
    huntbow(g, col) {
      line(g, (p) => p.M(-24, 24).L(-10, 10), rgba(lite(col, 0.4), 0.7), 2, null);
      glow(g, (p) => p.E(-9, 9, 4), col, { blur: 8, core: '#ffffff' });
      const ends = [[-2, -26, -0.5], [10, -22, -0.2], [20, -14, 0.1], [24, -2, 0.35], [22, 10, 0.6]];
      for (const [x, y, b] of ends) {
        const mx = (-9 + x) / 2 + b * 10, my = (9 + y) / 2 - (1 - b) * 4;
        line(g, (p) => p.M(-9, 9).Q(mx, my, x, y), rgba(lite(col, 0.3), 0.8), 1.4);
        const ang = (Math.atan2(y - my, x - mx) * 180) / Math.PI + 90;
        glow(g, (p) => p.P([0, -5, 2.4, 1.5, 0, 0.4, -2.4, 1.5]), col, { m: rot(ang, 1, x, y), blur: 4, core: lite(col, 0.6) });
      }
      spark(g, -9, 9, 5, '#ffffff');
    },
    // 一矢穿心：一支箭笔直贯穿三个靶心，箭尖一记暴击星芒
    eagle(g, col) {
      const m = rot(45, 1.25, 0, 0);
      for (const [x, y, r] of [[-12, 12, 6], [0, 0, 6.6], [12, -12, 7.2]]) {
        solid(g, (p) => p.E(x, y, r), '#5a3a2a', { hi: 0.3, lw: 1.5, bevel: 0.8 });
        line(g, (p) => p.E(x, y, r * 0.55), rgba('#e8d8c0', 0.7), 1.2);
      }
      line(g, (p) => p.M(-28, 28).L(-14, 14), rgba(lite(col, 0.4), 0.8), 2);
      glow(g, (p) => p.M(-1.2, 22).L(-1.2, -16).L(1.2, -16).L(1.2, 22).Z(), col, { m, blur: 6, core: lite(col, 0.3) });
      arrowAt(g, m, col, { shaft: '#d8d0c0' });
      spark(g, 15, -15, 8, '#ffffff');
      glow(g, (p) => p.E(0, 0, 2.2), '#ffd75e', { blur: 5, core: '#fff6d0' });
    },
    // 元素满溢：中间一枚箭镞，火、冰、雷三团元素绕着它转，拖着三色的弧
    runebow(g) {
      const E = [['#ff7a2c', -90], ['#86d8ff', 30], ['#ffe45e', 150]];
      for (const [c, a0] of E) {
        const a = (a0 * Math.PI) / 180;
        line(g, (p) => { for (let k = 0; k <= 10; k++) { const b = a - 1.6 + (k / 10) * 1.6; p[k ? 'L' : 'M'](Math.cos(b) * 18, Math.sin(b) * 18); } return p; }, rgba(c, 0.85), 2.2);
        glow(g, (p) => p.E(Math.cos(a) * 18, Math.sin(a) * 18, 5), c, { blur: 8, core: lite(c, 0.55) });
      }
      const m = rot(45, 1.1, 0, 0);
      glow(g, (p) => p.P([0, -12, 6, 2, 0, -1, -6, 2]), '#c9a6ff', { m, blur: 8, core: '#efe2ff' });
      solid(g, (p) => p.P([0, -12, 6, 2, 0, -1, -6, 2]), '#d8c4ff', { m, hi: 0.7, lw: 1.5, bevel: 0.8 });
      spark(g, 0, -3, 5, '#ffffff');
    },

    // 回锋斩：一记向右上的直刺（穿出去的刃光），外面绕着一道回身横扫的环形刃光
    blade(g, col) {
      const ring = (p, a0, a1, r0, r1) => {
        const N = 22;
        for (let i = 0; i <= N; i++) { const a = a0 + ((a1 - a0) * i) / N; p[i ? 'L' : 'M'](Math.cos(a) * r0, Math.sin(a) * r0); }
        for (let i = N; i >= 0; i--) { const f = i / N, a = a0 + (a1 - a0) * f, r = r1 + (r0 - r1) * (1 - Math.sin(f * Math.PI)) * 0.6; p.L(Math.cos(a) * r, Math.sin(a) * r); }
        return p.Z();
      };
      glow(g, (p) => ring(p, 0.2, 4.9, 26, 20), col, { blur: 7, core: col });
      solid(g, (p) => ring(p, 0.2, 4.9, 26, 20), lite(col, 0.4), { hi: 0.7, lo: 0.3, lw: 1.8, bevel: 1.1 });
      // 回旋方向的箭头尖
      const a = 4.9, x = Math.cos(a) * 23, y = Math.sin(a) * 23;
      solid(g, (p) => p.P([x + 5, y - 4.4, x + 1.4, y + 4.8, x - 3.2, y - 2.6]), lite(col, 0.5), { hi: 0.7, lw: 1.6, bevel: 0.9 });
      const m = rot(45, 1, 0, 0);
      line(g, (p) => p.M(-3.6, 16).L(-3.6, 6).M(3.6, 17).L(3.6, 8).M(0, 20).L(0, 10), rgba(lite(col, 0.5), 0.85), 1.5, m);
      glow(g, (p) => p.P([0, -22, 3.4, -15, 3, 8, -3, 8, -3.4, -15]), col, { m, blur: 8, core: col });
      solid(g, (p) => p.P([0, -22, 3.4, -15, 3, 8, -3, 8, -3.4, -15]), lite(col, 0.65), { m, hi: 0.7, lo: 0.25, lw: 1.9, bevel: 1.1 });
      solid(g, (p) => p.R(-7, 8, 14, 3.4, 1.2).R(-1.8, 11.4, 3.6, 5.6, 1), dark(col, 0.4), { m, hi: 0.4, lw: 1.7, bevel: 0.9 });
      spark(g, 15.5, -15.5, 5.6, '#ffffff');
    },
    // 地脉涌：地面上一圈裂开的光环，环上一根根地脉之刺往上涌
    staff(g, col) {
      const ky = 0.42, cy = 10;
      glow(g, (p) => p.E(0, cy, 24, 24 * ky), col, { stroke: 3.4, blur: 9, core: col });
      line(g, (p) => p.E(0, cy, 16, 16 * ky), rgba(lite(col, 0.5), 0.8), 1.4);
      const spikes = [[-21, 1], [-12, 0.75], [-4, 1.25], [5, 0.85], [13, 1.1], [21, 0.8]];
      for (const [x, k] of spikes) {
        const yb = cy + Math.sqrt(Math.max(0, 1 - (x / 24) * (x / 24))) * 24 * ky * (x % 2 ? -1 : 1) * 0.5;
        const h = 22 * k;
        solid(g, (p) => p.P([x - 3.4 * k, yb, x - 0.6, yb - h, x + 1, yb - h + 2, x + 3.4 * k, yb]), lite(col, 0.3 + k * 0.15), { hi: 0.7, lo: 0.3, lw: 1.7, bevel: 1 });
      }
      glow(g, (p) => p.E(0, cy, 5.6, 2.6), '#ffffff', { blur: 6, core: '#ffffff' });
      spark(g, -4, cy - 30, 4.4, '#ffffff');
    },
    // 秘弹连射：五颗小秘弹拖着弯曲的尾迹，从左下汇向右上的一个准星
    wand(g, col) {
      const tx = 15, ty = -15;
      glow(g, (p) => p.E(tx, ty, 7.6), col, { stroke: 1.6, blur: 5, core: lite(col, 0.5) });
      line(g, (p) => p.M(tx, ty - 11).L(tx, ty - 6).M(tx, ty + 6).L(tx, ty + 11).M(tx - 11, ty).L(tx - 6, ty).M(tx + 6, ty).L(tx + 11, ty), lite(col, 0.4), 1.4);
      const bolts = [[-24, 6, -0.9], [-18, 18, -0.4], [-6, 24, 0.3], [-14, -4, -1.3], [4, 12, 0.9]];
      bolts.forEach(([x, y, bend], i) => {
        const k = 0.55 + i * 0.1, ex = x + (tx - x) * k, ey = y + (ty - y) * k;
        const mx = (x + ex) / 2 + bend * 6, my = (y + ey) / 2 - bend * 6;
        line(g, (p) => p.M(x, y).Q(mx, my, ex, ey), rgba(lite(col, 0.3), 0.75), 1.8);
        glow(g, (p) => p.E(ex, ey, 3.4), col, { blur: 6, core: lite(col, 0.7) });
      });
      spark(g, tx, ty, 4.4, '#ffffff');
    },
    // 影刺：一道暗色的身影残像（新月形），一柄短刃从它背后斜刺下去，刃尖迸出暴击的星芒
    daggers(g, col) {
      glow(g, (p) => p.M(-6, -25).C(-26, -18, -26, 14, -6, 22).C(-16, 10, -16, -12, -6, -25).Z(), col, { blur: 8, core: mix(col, '#141226', 0.45) });
      solid(g, (p) => p.M(-6, -25).C(-26, -18, -26, 14, -6, 22).C(-16, 10, -16, -12, -6, -25).Z(), mix(col, '#141226', 0.55), { hi: 0.35, lo: 0.4, lw: 1.6, bevel: 0 });
      line(g, (p) => p.M(-24, -9).L(-31, -9).M(-25, 0).L(-32, 0).M(-24, 9).L(-30, 9), rgba(lite(col, 0.3), 0.7), 1.5);
      const m = rot(-145, 1.05, 4, 1);
      glow(g, (p) => p.M(-3, 5).L(-3.4, -9).Q(-2, -18, 1.4, -22).Q(3.6, -14, 3.2, -6).L(3, 5).Z(), col, { m, blur: 7, core: col });
      solid(g, (p) => p.M(-3, 5).L(-3.4, -9).Q(-2, -18, 1.4, -22).Q(3.6, -14, 3.2, -6).L(3, 5).Z(), lite(col, 0.6), { m, hi: 0.7, lo: 0.25, lw: 1.9, bevel: 1.1 });
      solid(g, (p) => p.R(-6.4, 5, 12.8, 3.2, 1.2).R(-1.8, 8.2, 3.6, 7.6, 1), dark(col, 0.45), { m, hi: 0.4, lw: 1.7, bevel: 0.9 });
      spark(g, 15.4, 19.6, 8, '#ffffff');
      spark(g, 22.4, 11, 3.6, lite(col, 0.5));
    },
    // 震地：锤头砸在左下的地面，冲击波朝右上一路变宽
    hammer(g, col) {
      for (let i = 0; i < 3; i++) {
        const r = 12 + i * 8.5, w = 0.5 + i * 0.16, a0 = -Math.PI / 4;
        glow(g, (p) => { for (let k = 0; k <= 8; k++) { const a = a0 - w + (2 * w * k) / 8; p[k ? 'L' : 'M'](-12 + Math.cos(a) * r, 12 + Math.sin(a) * r); } return p; }, col, { stroke: 3.2 - i * 0.6, blur: 6, core: lite(col, 0.5 - i * 0.1) });
      }
      // 碎石
      solid(g, (p) => p.P([6, 0, 9, -3, 11, 0, 8.6, 2.4]).P([-1, 8, 2, 6, 3.4, 9, 0, 10.4]).P([13, 10, 16, 8.4, 17, 11.6]), dark(col, 0.25), { hi: 0.4, lw: 1.3, bevel: 0 });
      glow(g, (p) => p.E(-12, 13, 9, 4), col, { blur: 8, core: lite(col, 0.6) });
      const m = rot(-40, 1.08, -12, 10);
      tube(g, (p) => p.M(0, -5).L(0, -27), C.wood, 3.2, { m });
      solid(g, (p) => p.R(-12.5, -6.5, 25, 12, 1.8), C.steel, { m, hi: 0.5, lo: 0.45, bevel: 1.3 });
      solid(g, (p) => p.R(-3.4, -8, 6.8, 15, 1), dark(col, 0.3), { m, hi: 0.45, bevel: 1 });
      line(g, (p) => p.M(-10.6, -3.6).L(-10.6, 3).M(10.6, -3.6).L(10.6, 3), rgba('#ffffff', 0.6), 1, m);
      spark(g, 19, -19, 5.4, '#ffffff');
    },
    // 箭雨：五支箭斜着落向地上的一个圈
    bow(g, col) {
      glow(g, (p) => p.E(2, 18, 21, 7.6), col, { stroke: 2.2, blur: 6, core: lite(col, 0.4) });
      const arrows = [[-14, -8, 0.95], [-2, -18, 1.05], [10, -10, 0.9], [-6, 2, 0.85], [14, 3, 0.8]];
      for (const [x, y, k] of arrows) {
        const m = rot(-150, k, x, y);
        line(g, (p) => p.M(0, 14).L(0, 26), rgba(lite(col, 0.4), 0.55), 1.4, m);
        tube(g, (p) => p.M(0, 9).L(0, -6), C.woodD, 1.3, { m });
        solid(g, (p) => p.M(0, 7).L(-2.6, 10.6).L(-2.6, 12.4).L(0, 10).L(2.6, 12.4).L(2.6, 10.6).Z(), lite(col, 0.2), { m, bevel: 0, lw: 1 });
        glow(g, (p) => p.P([0, -12, 2.6, -5, 0, -6.4, -2.6, -5]), col, { m, blur: 4, core: lite(col, 0.6) });
      }
      spark(g, 2, 18, 4.4, '#ffffff');
    },
    // 瞬断：一道横贯的细长斩光，身后拖着冲刺的残影线，斩痕上迸出几处断口
    katana(g, col) {
      const m = rot(-28, 1, 0, 0);
      line(g, (p) => p.M(-30, -7).L(-14, -7).M(-29, 6).L(-10, 6).M(-26, 13).L(-18, 13), rgba(lite(col, 0.4), 0.8), 1.6, m);
      glow(g, (p) => p.M(-24, 1.4).Q(0, -2.6, 28, 0).Q(0, 1.4, -24, 1.4).Z(), col, { m, blur: 10, core: col });
      solid(g, (p) => p.M(-24, 1.6).Q(0, -3.2, 28, 0).Q(0, 1.8, -24, 1.6).Z(), '#ffffff', { m, hi: 0, lo: 0.1, lw: 1.3, bevel: 0 });
      for (const [x, s] of [[-8, 7], [6, 9], [18, 6]]) {
        solid(g, (p) => p.P([x - 2, -s * 0.2, x + 1.8, -s, x + 2.4, -s * 0.15, x + 0.4, s * 0.9]), lite(col, 0.45), { m, hi: 0.7, lw: 1.4, bevel: 0 });
      }
      spark(g, 24, -12, 6.4, '#ffffff');
    },
    // 魂潮：左下一面小魂幡，四团魂火拖着弯尾从幡上涌向右上；幡脚一圈短促的「狂热」折线
    banner(g, col) {
      const m = rot(10, 0.86, -17, 7);
      // 幡
      tube(g, (p) => p.M(0, 24).L(0, -20), C.duskD, 2.6, { m });
      solid(g, (p) => p.M(1.2, -17).L(12, -17.4).C(12.6, -10, 10.8, -3, 12.4, 4).L(10.4, 1.8).L(9, 7).L(7.2, 2.6).L(5.4, 8.4).L(3.8, 3.6).L(2.2, 6.6).L(1.6, 2).C(0.8, -4, 2.2, -10, 1.2, -17).Z(), '#2d3038', { m, hi: 0.25, lo: 0.5, bevel: 1, lw: 1.8 });
      glow(g, (p) => p.M(3.4, -9).Q(6.6, -13, 9.8, -9).Q(6.6, -5.2, 3.4, -9).Z(), col, { m, stroke: 1.1, blur: 4, core: lite(col, 0.7) });
      tube(g, (p) => p.M(-1.8, -17.6).L(14, -18), C.duskD, 1.8, { m });
      // 魂火：头是发光的圆，尾巴是一条渐细的弯弧
      const wisp = (x0, y0, x1, y1, bend, r) => {
        const mx = (x0 + x1) / 2 - (y1 - y0) * bend, my = (y0 + y1) / 2 + (x1 - x0) * bend;
        const dx = x1 - mx, dy = y1 - my, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
        glow(g, (p) => p.M(x0, y0).Q(mx + nx * r * 0.5, my + ny * r * 0.5, x1 + nx * r, y1 + ny * r).L(x1 - nx * r, y1 - ny * r).Q(mx - nx * r * 0.5, my - ny * r * 0.5, x0, y0).Z(), col, { blur: 6, core: rgba(lite(col, 0.35), 0.75) });
        glow(g, (p) => p.E(x1, y1, r * 1.15), col, { blur: 8, core: lite(col, 0.75) });
        glow(g, (p) => p.E(x1 - r * 0.3, y1 - r * 0.3, r * 0.45), '#ffffff', { blur: 3, core: '#ffffff' });
      };
      wisp(-8, -8, 4, -22, 0.25, 3.2);
      wisp(-6, -3, 17, -15, 0.22, 3.6);
      wisp(-4, 2, 22, 0, 0.2, 3.1);
      wisp(-6, 6, 12, 14, -0.18, 2.6);
      // 狂热：幡脚两道短折线
      line(g, (p) => p.M(-27, 24).L(-24, 20).L(-21, 24).M(-12, 25).L(-9, 21).L(-6, 25), rgba(lite(col, 0.4), 0.85), 1.6);
      spark(g, 21, -21, 5, '#ffffff');
    },
  };
  // =====================================================================
  // 烬铸技：先画一圈余烬框（暗金红的描边、四角各一颗火星、底下一层余烬的光），再画招式本身
  // =====================================================================
  const EMB = '#ff9b3d';
  const ICE = '#7fd4ff';
  function emberFrame(g) {
    const sq = (p, r) => p.R(-r, -r, r * 2, r * 2, 7);
    glow(g, (p) => sq(p, 28.5), EMB, { stroke: 2.2, blur: 8, core: rgba('#ff8a30', 0.75) });
    line(g, (p) => sq(p, 28.5), rgba('#ffd7a0', 0.85), 1.1);
    line(g, (p) => sq(p, 25.6), rgba('#a8461a', 0.7), 0.8);
    for (const [x, y] of [[-28.5, -28.5], [28.5, -28.5], [-28.5, 28.5], [28.5, 28.5]]) {
      solid(g, (p) => p.P([x, y - 4.2, x + 4.2, y, x, y + 4.2, x - 4.2, y]), '#ffb066', { hi: 0.6, lo: 0.4, lw: 1.3, bevel: 0 });
    }
    // 底边往上飘的几颗火星
    for (const [x, y, r] of [[-16, 24, 1.6], [-5, 26, 1.1], [9, 23.5, 1.4], [19, 25.5, 1.0]]) glow(g, (p) => p.E(x, y, r), EMB, { blur: 4, core: '#ffe2b8' });
  }
  const USKILL_DRAW = {
    // 乱射：中间一把左轮，八道弹道朝四面八方甩出去，弹道尽头各一点火星
    wildfire(g, col) {
      emberFrame(g);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.2, r0 = 8, r1 = 22 + (i % 2) * 3;
        glow(g, (p) => p.M(Math.cos(a) * r0, Math.sin(a) * r0).L(Math.cos(a) * r1, Math.sin(a) * r1), col, { stroke: 1.6, blur: 4, core: lite(col, 0.5) });
        glow(g, (p) => p.E(Math.cos(a) * r1, Math.sin(a) * r1, 1.6), EMB, { blur: 4, core: '#fff0d0' });
      }
      const m = rot(30, 0.62, 0, 2);
      solid(g, (p) => p.R(-2.4, -22, 4.8, 17, 1), '#2e2628', { m, hi: 0.35, lw: 2.4 });
      solid(g, (p) => p.R(-6, -6, 12, 9, 2.4), '#2e2628', { m, hi: 0.4, lw: 2.4 });
      solid(g, (p) => p.M(-3.6, 3).L(2.4, 3).L(7, 17).Q(3.4, 19.4, 0.6, 17.6).Z(), '#4a2a1c', { m, bevel: 1.1, lw: 2.4 });
      for (const x of [-3, 0, 3]) glow(g, (p) => p.E(x, -2.6, 1), EMB, { m, blur: 3, core: '#ffd2a0' });
      glow(g, (p) => p.E(0, 0, 6), EMB, { blur: 10, core: rgba('#ffb066', 0.25) });
    },
    // 凛冬：三支寒冰箭扇形射出，脚下一排冰棱
    emberstorm(g, col) {
      emberFrame(g);
      for (let i = 0; i < 5; i++) {
        const x = -16 + i * 8, h = 7 + (i % 2) * 5;
        const tr = (p) => p.M(x - 3, 24).L(x - 0.6, 24 - h).L(x + 0.6, 24 - h - 1).L(x + 3, 24).Z();
        glow(g, tr, ICE, { blur: 5, core: rgba('#dff4ff', 0.85) });
      }
      for (const [deg, x, y] of [[-20, -9, 4], [0, 0, 1], [20, 9, 4]]) {
        const m = rot(deg, 0.95, x, y);
        glow(g, (p) => p.M(-3, 8).Q(0, 22, 0, 26).Q(0, 22, 3, 8).Z(), ICE, { m, blur: 6, core: rgba('#dff4ff', 0.8) });
        arrowAt(g, m, col, { shaft: '#22303c', fletch: '#9fd8ff', blur: 6 });
      }
      spark(g, 0, -15, 6, '#ffffff');
    },
    // 千刃归烬：一柄倒插的太刀，四周六道交错的斩光，中心炸开一团白热的余烬
    ashcuts(g, col) {
      emberFrame(g);
      glow(g, (p) => p.E(0, 2, 12), EMB, { blur: 14, core: rgba('#ffb066', 0.55) });
      const cuts = [[-38, 25], [22, 24], [-75, 21], [70, 22], [5, 26], [-12, 19]];
      for (const [deg, len] of cuts) {
        const m = rot(deg, 1, 0, 2);
        glow(g, (p) => p.M(-len, 0.9).Q(0, -1.8, len, 0).Q(0, 1.6, -len, 0.9).Z(), col, { m, blur: 6, core: lite(col, 0.35) });
        solid(g, (p) => p.M(-len * 0.8, 0.5).Q(0, -1, len * 0.8, 0).Q(0, 0.9, -len * 0.8, 0.5).Z(), '#fff4e0', { m, hi: 0, lo: 0.1, lw: 0, bevel: 0 });
      }
      // 太刀：刃朝下斜插，刀镡与柄在右上
      const m = rot(-148, 1, 3, 0);
      glow(g, (p) => p.M(-1.8, 9).L(-2, -14).Q(-1.2, -21, 1.6, -24).Q(2.4, -16, 2, -6).L(1.8, 9).Z(), col, { m, blur: 6, core: col });
      solid(g, (p) => p.M(-1.8, 9).L(-2, -14).Q(-1.2, -21, 1.6, -24).Q(2.4, -16, 2, -6).L(1.8, 9).Z(), lite(col, 0.75), { m, hi: 0.7, lo: 0.2, lw: 1.7, bevel: 1 });
      solid(g, (p) => p.E(0, 10, 4.6, 1.6), '#5a3418', { m, hi: 0.5, lw: 1.5, bevel: 0.8 });
      tube(g, (p) => p.M(0, 12).L(0, 21), '#3a2418', 2.6, { m });
      spark(g, 0, 2, 7, '#ffffff');
      spark(g, 17, -17, 4.2, '#ffe2b8');
    },
    // 三相天灾：头顶一团暗云，底下三击——陨火（橙）、冰棱（蓝）、落雷（黄），地上一圈三色的法阵
    tristorm(g) {
      emberFrame(g);
      const F = '#ff7a2c', C = '#7fd4ff', L = '#ffe45e';
      const ky = 0.36, cy = 18;
      glow(g, (p) => p.E(0, cy, 21, 21 * ky), F, { stroke: 2.2, blur: 5, core: lite(F, 0.3) });
      glow(g, (p) => p.E(0, cy, 15.5, 15.5 * ky), C, { stroke: 1.8, blur: 5, core: lite(C, 0.3) });
      glow(g, (p) => p.E(0, cy, 10, 10 * ky), L, { stroke: 1.5, blur: 5, core: lite(L, 0.3) });
      // 云
      solid(g, (p) => p.M(-22, -10).C(-26, -18, -18, -24, -11, -21).C(-8, -29, 4, -29, 7, -22).C(13, -27, 23, -22, 21, -14).C(26, -11, 23, -5, 17, -6).L(-17, -6).C(-23, -5, -25, -8, -22, -10).Z(), '#3a3442', { hi: 0.35, lo: 0.5, lw: 1.8, bevel: 1.2 });
      line(g, (p) => p.M(-14, -12).C(-8, -16, -2, -15, 2, -12).M(5, -14).C(9, -17, 14, -16, 16, -12), rgba('#8f86a0', 0.7), 1.1);
      // 陨火（左）
      glow(g, (p) => p.M(-17, -4).L(-11, 9).L(-14, 10).Z(), F, { blur: 6, core: rgba(lite(F, 0.4), 0.8) });
      solid(g, (p) => p.P([-12, 9, -8, 7.5, -7, 12, -10.5, 14.5, -14, 12.5]), '#6a4a3a', { hi: 0.4, lw: 1.4, bevel: 0.8 });
      glow(g, (p) => p.E(-10.5, 11, 3), F, { blur: 6, core: lite(F, 0.5) });
      // 冰棱（中）
      solid(g, (p) => p.P([0, 15, -3, 2, 0, -6, 3, 2]), lite(C, 0.25), { hi: 0.8, lo: 0.3, lw: 1.5, bevel: 0.9 });
      glow(g, (p) => p.E(0, 15, 3), C, { blur: 6, core: '#e8faff' });
      // 落雷（右）
      glow(g, (p) => p.M(14, -6).L(10, 3).L(14, 3).L(10, 15).L(19, 1).L(15, 1).L(18, -6).Z(), L, { blur: 7, core: lite(L, 0.55) });
      solid(g, (p) => p.M(14, -6).L(10, 3).L(14, 3).L(10, 15).L(19, 1).L(15, 1).L(18, -6).Z(), lite(L, 0.4), { hi: 0.6, lo: 0.25, lw: 1.3, bevel: 0 });
      spark(g, 10, 15, 4, '#ffffff');
    },
    // 万魂降临：一面插在地上的魂幡，两侧三位英灵的魂影（盔顶 + 肩甲的剪影）从地里升起，头顶一道天光
    soulhost(g, col) {
      emberFrame(g);
      glow(g, (p) => p.P([-4, -27, 4, -27, 9, 22, -9, 22]), col, { blur: 10, core: rgba(lite(col, 0.4), 0.28) });
      const ghost = (x, y, k, warm) => {
        const tr = (p) => p.M(x, y - 11 * k).C(x + 5 * k, y - 11 * k, x + 5.5 * k, y - 6 * k, x + 4.5 * k, y - 3.5 * k).L(x + 9 * k, y - 1 * k).C(x + 10 * k, y + 4 * k, x + 7 * k, y + 10 * k, x + 5 * k, y + 14 * k)
          .L(x + 2 * k, y + 11 * k).L(x, y + 15 * k).L(x - 2 * k, y + 11 * k).L(x - 5 * k, y + 14 * k).C(x - 7 * k, y + 10 * k, x - 10 * k, y + 4 * k, x - 9 * k, y - 1 * k).L(x - 4.5 * k, y - 3.5 * k).C(x - 5.5 * k, y - 6 * k, x - 5 * k, y - 11 * k, x, y - 11 * k).Z();
        glow(g, tr, col, { blur: 7, core: rgba(lite(col, 0.3), 0.55) });
        line(g, tr, rgba(warm ? '#ffb066' : lite(col, 0.6), 0.9), 1.1);
        glow(g, (p) => p.M(x - 3 * k, y - 6.5 * k).L(x + 3 * k, y - 6.5 * k), warm ? '#ffb066' : '#e8fff8', { stroke: 1.2, blur: 3, core: '#ffffff' });
      };
      ghost(-17, 6, 0.95, false);
      ghost(17, 6, 0.95, true);
      ghost(0, 0, 1.15, false);
      // 幡：杆插在地上，幡布在杆头
      tube(g, (p) => p.M(-1, 26).L(-1, -24), C.duskD, 2.4);
      solid(g, (p) => p.M(0, -22).L(10, -22.4).C(10.6, -16, 9, -10, 10.4, -4).L(8.4, -6).L(7, -1.6).L(5.4, -5.4).L(3.8, -1).L(2.2, -4.6).L(0.6, -1.4).Z(), '#2d3038', { hi: 0.25, lo: 0.5, bevel: 1, lw: 1.6 });
      glow(g, (p) => p.E(5, -14, 2.4), EMB, { blur: 5, core: '#ffe2b8' });
      glow(g, (p) => p.E(-1, 25, 9, 2.6), col, { blur: 6, core: lite(col, 0.5) });
      spark(g, -1, -26, 5, '#ffffff');
    },
  };

  // =====================================================================
  // 武器普攻（右键「开火」/「射击」）：按武器类型画，id 为 basic_<type>
  // =====================================================================
  const BASIC_DRAW = {
    // 机炮开火：三道并排的曳光弹扫向右上，枪口一团十字星焰，旁边一圈转动的弧线（转膛）
    gatling(g, col) {
      for (const [o, l] of [[-6, 0.8], [0, 1], [6, 0.75]]) {
        const m = rot(45, 1, o * 0.7, o * 0.7);
        glow(g, (p) => p.M(0, -8).L(0, -8 - 18 * l), col, { m, stroke: 2, blur: 4, core: lite(col, 0.55) });
        glow(g, (p) => p.E(0, -8 - 18 * l, 1.6), '#ffffff', { m, blur: 3, core: '#ffffff' });
      }
      glow(g, (p) => p.P([-8, 8, -5, 4.6, -1.6, 2, -5, 0.4, -8, -4, -11, 0.4, -14.4, 2, -11, 4.6]), col, { blur: 7, core: lite(col, 0.6) });
      line(g, (p) => { for (let k = 0; k <= 12; k++) { const a = 2.2 + (k / 12) * 2.6; p[k ? 'L' : 'M'](-14 + Math.cos(a) * 12, 14 + Math.sin(a) * 12); } return p; }, rgba(lite(col, 0.3), 0.8), 1.6);
      solid(g, (p) => p.R(-26, 11, 13, 8, 2), C.ironD, { m: rot(45, 1, -2, 2), bevel: 1, lw: 1.6 });
      spark(g, -8, 2, 6, '#ffffff');
    },
    // 喷枪开火：喷嘴往右上喷出一道越来越宽的火舌
    flamer(g, col) {
      const m = rot(45, 1, 0, 0);
      glow(g, (p) => p.M(0, 14).C(-6, 4, -14, -10, -10, -26).Q(0, -30, 10, -26).C(14, -10, 6, 4, 0, 14).Z(), col, { m, blur: 9, core: rgba(lite(col, 0.2), 0.85) });
      glow(g, (p) => p.M(0, 14).C(-3, 4, -7, -8, -5, -20).Q(0, -23, 5, -20).C(7, -8, 3, 4, 0, 14).Z(), '#ffd08a', { m, blur: 5, core: rgba('#fff0c8', 0.9) });
      solid(g, (p) => p.M(-3.4, 14).L(-5, 20).L(5, 20).L(3.4, 14).Z(), C.ironD, { m, bevel: 0.9, lw: 1.6 });
      tube(g, (p) => p.M(0, 20).L(0, 28), C.iron, 3.4, { m });
      spark(g, 8, -8, 4, '#ffffff');
    },
    // 左轮开火：一发拖着长焰的重弹，枪口一记爆焰，身后一圈六个弹巢
    revolver(g, col) {
      for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; solid(g, (p) => p.E(-14 + Math.cos(a) * 6.6, 14 + Math.sin(a) * 6.6, 2.4), '#3a2e2a', { bevel: 0, lw: 1.2 }); }
      glow(g, (p) => p.E(-14, 14, 2.2), EMB_C, { blur: 4, core: '#ffd2a0' });
      const m = rot(45, 1, 0, 0);
      glow(g, (p) => p.M(-2.2, 4).L(0, -24).L(2.2, 4).Z(), col, { m, blur: 7, core: lite(col, 0.5) });
      solid(g, (p) => p.M(-2.6, -18).Q(0, -27, 2.6, -18).L(2.6, -12).L(-2.6, -12).Z(), '#e8c070', { m, hi: 0.7, lw: 1.5, bevel: 0.8 });
      glow(g, (p) => p.P([0, 4, 4, 9, 9, 8, 5, 12, 6, 17, 0, 13, -6, 17, -5, 12, -9, 8, -4, 9]), '#ff9a40', { m, blur: 6, core: '#fff0c8' });
      spark(g, 10, -10, 5, '#ffffff');
    },
    // 猎弓射击：一支箭拐着弧线追向右上的靶环
    huntbow(g, col) {
      glow(g, (p) => p.E(16, -16, 8), col, { stroke: 1.6, blur: 4, core: lite(col, 0.4) });
      line(g, (p) => p.E(16, -16, 3.4), lite(col, 0.4), 1.2);
      line(g, (p) => p.M(-26, 20).Q(-14, -10, 6, -10), rgba(lite(col, 0.3), 0.85), 1.6, null, [3, 2.2]);
      arrowAt(g, rot(70, 0.95, 6, -11), col);
      spark(g, 16, -16, 4, '#ffffff');
    },
    // 鹰眼射击：一支长箭笔直飞向准星，准星中心一记暴击星芒
    eagle(g, col) {
      const tx = 15, ty = -15;
      glow(g, (p) => p.E(tx, ty, 8), col, { stroke: 1.4, blur: 4, core: lite(col, 0.4) });
      line(g, (p) => p.M(tx, ty - 12).L(tx, ty - 5).M(tx, ty + 5).L(tx, ty + 12).M(tx - 12, ty).L(tx - 5, ty).M(tx + 5, ty).L(tx + 12, ty), lite(col, 0.3), 1.4);
      arrowAt(g, rot(45, 1.1, -5, 5), '#ffd75e', { trail: 10, shaft: '#d8d0c0' });
      spark(g, tx, ty, 6.4, '#ffffff');
    },
    // 符文弓射击：箭身拖着火、冰、雷三色的尾迹
    runebow(g, col) {
      const m = rot(45, 1.1, 0, 0);
      const E = ['#ff7a2c', '#86d8ff', '#ffe45e'];
      E.forEach((c, i) => glow(g, (p) => p.M((i - 1) * 3.4, 12).Q((i - 1) * 6, 22, (i - 1) * 2.4, 28), c, { m, stroke: 2, blur: 4, core: lite(c, 0.4) }));
      arrowAt(g, m, col, { shaft: '#5a6680', fletch: '#c9d4e8' });
      glow(g, (p) => p.E(11.5, -11.5, 4), col, { blur: 8, core: '#efe2ff' });
      spark(g, 11.5, -11.5, 4, '#ffffff');
    },
    // 烬铸弓（凛羽）射击：一支寒冰箭，命中处迸出冰晶，跳向旁边两个点
    emberbow(g, col) {
      const m = rot(45, 1, -4, 4);
      glow(g, (p) => p.M(-3, 6).Q(0, 20, 0, 24).Q(0, 20, 3, 6).Z(), ICE, { m, blur: 6, core: rgba('#dff4ff', 0.8) });
      arrowAt(g, m, col, { shaft: '#22303c', fletch: '#9fd8ff' });
      const hx = 8, hy = -16;
      for (const [x, y] of [[22, -8], [16, 6]]) {
        line(g, (p) => p.M(hx, hy).Q((hx + x) / 2 + 4, (hy + y) / 2 - 6, x, y), rgba('#9fd8ff', 0.9), 1.4, null, [2, 2]);
        glow(g, (p) => p.M(x, y - 3).L(x + 2.2, y).L(x, y + 3).L(x - 2.2, y).Z(), ICE, { blur: 5, core: '#f0faff' });
      }
      spark(g, hx, hy, 6, '#ffffff');
    },
  };
  const EMB_C = '#ff9b3d';
  // 普攻卡在没拿远程武器时的空白图标：一枚弹壳和一支箭交叉
  function drawBasicBlank(g) {
    arrowAt(g, rot(45, 1.1, 0, 0), '#c8bca8', { shaft: '#7a6a58', fletch: '#a89c88' });
    solid(g, (p) => p.R(-3, -9, 6, 16, 2), '#b08a4a', { m: rot(-45, 1, 0, 0), hi: 0.5, lw: 1.6 });
  }

  // 武器技的技能 id → 武器类型（读 G.BASES.weapon 的 wskill 字段）
  function wskillType(id) {
    const ws = (G.BASES && G.BASES.weapon) || [];
    for (let i = 0; i < ws.length; i++) if (ws[i] && ws[i].wskill === id) return weaponType(i);
    const sk = G.SKILLS && G.SKILLS[id];
    if (sk && WSKILL_DRAW[sk.wtype]) return sk.wtype;
    if (sk && WSKILL_DRAW[sk.weapon]) return sk.weapon;
    return null;
  }

  // =====================================================================
  // 小符号：辅助宝石上的刻纹、异常状态
  // =====================================================================
  const GLYPH = {
    multi: (p) => p.M(-8.4, -1.6).L(3.4, -6.6).M(-8.4, 0).L(4.6, 0).M(-8.4, 1.6).L(3.4, 6.6).E(5.8, -7.4, 1.9).E(7.2, 0, 1.9).E(5.8, 7.4, 1.9),
    pierce: (p) => p.M(-9, 0).L(8, 0).M(4, -4).L(8.6, 0).L(4, 4).M(-2.4, -7).L(-2.4, 7),
    chain: (p) => p.M(-7.6, 5).L(-1.2, -5).L(7.2, 4.4).E(-7.6, 5.4, 1.8).E(-1.2, -5.6, 1.8).E(7.4, 4.8, 1.8),
    expanse: (p) => { p.E(0, 0, 3); for (let i = 0; i < 4; i++) { const a = i * (Math.PI / 2) + 0.42; p.M(Math.cos(a) * 8.4, Math.sin(a) * 8.4); for (let j = 1; j <= 5; j++) { const b = a + (j / 5) * 0.74; p.L(Math.cos(b) * 8.4, Math.sin(b) * 8.4); } } return p; },
    haste: (p) => p.M(-7.4, -6.4).L(-1, 0).L(-7.4, 6.4).M(0.6, -6.4).L(7, 0).L(0.6, 6.4),
    fire: (p) => p.M(0, -9).C(5.4, -3, 7, 1, 5.4, 5).C(3, 9.6, -3, 9.6, -5.4, 5).C(-7, 1, -2.6, -1, -2.6, -4.6).C(-1, -3, -0.6, -6, 0, -9).Z(),
    cold: (p) => { for (let i = 0; i < 3; i++) { const a = (i * Math.PI) / 3, c = Math.cos(a), s = Math.sin(a); p.M(-c * 8.6, -s * 8.6).L(c * 8.6, s * 8.6); for (const k of [-1, 1]) { const x = c * 5.4 * k, y = s * 5.4 * k; p.M(x - s * 2.4 + c * 2 * k, y + c * 2.4 + s * 2 * k).L(x, y).L(x + s * 2.4 + c * 2 * k, y - c * 2.4 + s * 2 * k); } } return p; },
    light: (p) => p.M(2.6, -9.4).L(-4.4, 0.8).L(0.6, 0.8).L(-2.6, 9.4).L(5, -1.8).L(0, -1.8).Z(),
    brutal: (p) => p.M(-2.4, 9).L(2.6, -1).M(-4.6, -6.6).L(5.4, -1.6).L(7.4, -5.6).L(-2.6, -10.4).Z(),
    precise: (p) => p.E(0, 0, 4.6).M(0, -9.4).L(0, -6).M(0, 6).L(0, 9.4).M(-9.4, 0).L(-6, 0).M(6, 0).L(9.4, 0),
    leech: (p) => p.M(0, -9.4).C(5.6, -2, 7.4, 1.4, 5.6, 5.4).C(3, 9.4, -3, 9.4, -5.6, 5.4).C(-7.4, 1.4, -5.6, -2, 0, -9.4).Z().M(0, -0.6).L(0, 5.6).M(-3, 2.6).L(3, 2.6),
    echo: (p) => { for (let i = 0; i < 3; i++) { const r = 3.4 + i * 3.4, x = -6.4; p.M(x + Math.cos(-0.95) * r, Math.sin(-0.95) * r); for (let j = 1; j <= 8; j++) { const a = -0.95 + (j / 8) * 1.9; p.L(x + Math.cos(a) * r, Math.sin(a) * r); } } return p; },
    stagger: (p) => { for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU - Math.PI / 2, r = i % 2 ? 4 : 9.6; p[i ? 'L' : 'M'](Math.cos(a) * r, Math.sin(a) * r); } return p.Z(); },
    ailment: (p) => { for (const d of [[-5, -3, 1], [4.6, -5.6, 0.85], [1, 4.4, 1.1]]) { const x = d[0], y = d[1], k = d[2]; p.M(x, y - 4.4 * k).C(x + 3 * k, y - 0.6 * k, x + 3.4 * k, y + 1.4 * k, x + 2.4 * k, y + 2.8 * k).C(x + 1.2 * k, y + 4.4 * k, x - 1.2 * k, y + 4.4 * k, x - 2.4 * k, y + 2.8 * k).C(x - 3.4 * k, y + 1.4 * k, x - 3 * k, y - 0.6 * k, x, y - 4.4 * k).Z(); } return p; },
    frugal: (p) => p.M(-6, -8.6).L(6, -8.6).L(0.8, 0).L(6, 8.6).L(-6, 8.6).L(-0.8, 0).Z().M(-7.4, -8.6).L(7.4, -8.6).M(-7.4, 8.6).L(7.4, 8.6),
    freeze: (p) => p.P([0, -9.4, 6.6, -4, 6.6, 4, 0, 9.4, -6.6, 4, -6.6, -4]).M(0, -9.4).L(0, 9.4).M(-6.6, -4).L(6.6, 4).M(6.6, -4).L(-6.6, 4),
    // 仆从辅助：驭灵（骷髅）、坚骨（盾里一根骨）、群聚（三个人头）、狂怒（三道爪痕）
    m_dmg: (p) => p.M(-6.8, 3).C(-10.4, -1.6, -8.8, -9.6, 0, -9.6).C(8.8, -9.6, 10.4, -1.6, 6.8, 3).L(4.6, 4.6).L(4.6, 8.6).L(-4.6, 8.6).L(-4.6, 4.6).Z()
      .E(-3.4, -1.8, 2.1).E(3.4, -1.8, 2.1).M(-1.6, 5.4).L(-1.6, 8.4).M(1.6, 5.4).L(1.6, 8.4),
    m_life: (p) => p.M(0, -9.6).L(8, -6.6).C(8, 1.6, 4.8, 6.6, 0, 9.8).C(-4.8, 6.6, -8, 1.6, -8, -6.6).Z()
      .M(0, -3.2).L(0, 3.6).E(-1.5, -4.4, 1.5).E(1.5, -4.4, 1.5).E(-1.5, 4.8, 1.5).E(1.5, 4.8, 1.5),
    m_horde: (p) => p.E(0, -4.4, 2.8).E(-6.4, -1.6, 2.2).E(6.4, -1.6, 2.2)
      .M(-4.6, 8.4).Q(-4.6, 0.6, 0, 0.6).Q(4.6, 0.6, 4.6, 8.4)
      .M(-10.6, 7.8).Q(-10.4, 2, -6.4, 2).Q(-4.4, 2, -3.6, 3.2).M(3.6, 3.2).Q(4.4, 2, 6.4, 2).Q(10.4, 2, 10.6, 7.8),
    m_speed: (p) => p.M(-9, 5.4).Q(-6.4, -3.4, -1.6, -9.4).M(-4, 9.4).Q(-1, -0.4, 4.4, -7.4).M(1.8, 9.8).Q(5, 2.4, 9.6, -3.6),
  };
  const GLYPH_FILL = { fire: 1, light: 1, stagger: 1, ailment: 1, frugal: 1, brutal: 1 }; // 这些符号画成实心
  const SUP_TINT = {
    multi: '#ffb066', pierce: '#b9c6dc', chain: '#ffe45e', expanse: '#7fe0c0', haste: '#7ed67a', fire: '#ff7a2c', cold: '#86d8ff', light: '#ffe45e',
    brutal: '#e2705a', precise: '#ffd75e', leech: '#ff6a8a', echo: '#c7a6ff', stagger: '#f2e6b0', ailment: '#b6e05c', frugal: '#6fb2ff',
    m_dmg: '#3fe0c8', m_life: '#d2b47a', m_horde: '#e28ad6', m_speed: '#ff5a46',
  };
  // 仆从辅助宝石的 id 由数据那边定；按 id 认不出时按名字认，两边怎么起名都对得上
  const SUP_BY_NAME = { 驭灵: 'm_dmg', 坚骨: 'm_life', 群聚: 'm_horde', 狂怒: 'm_speed' };
  function supKey(id) {
    if (GLYPH[id]) return id;
    const sp = G.SUPPORTS && G.SUPPORTS[id];
    return (sp && SUP_BY_NAME[sp.name]) || id;
  }
  const AIL = { burn: ['fire', '#ff8a3c'], chill: ['cold', '#86d8ff'], freeze: ['freeze', '#d6f3ff'], shock: ['light', '#ffe45e'], stun: ['stagger', '#ffffff'] };

  function drawGlyph(g, name, col, m, w) {
    const tr = GLYPH[name];
    if (!tr) return;
    const fill = !!GLYPH_FILL[name];
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    tr(pen(g, m));
    g.lineWidth = (w || 2.3) + 2.6;
    g.strokeStyle = 'rgba(12,7,5,0.92)';
    g.stroke();
    g.shadowColor = col;
    g.shadowBlur = 3 * U;
    if (fill) {
      g.fillStyle = col;
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 1;
      g.strokeStyle = col;
      g.stroke();
    } else {
      g.lineWidth = w || 2.3;
      g.strokeStyle = col;
      g.stroke();
    }
    g.restore();
  }

  // 辅助宝石：银托 + 按宝石染色的圆形刻面石 + 白色刻纹
  function drawSupport(g, id) {
    id = supKey(id);
    const col = SUP_TINT[id] || '#d8d8e0';
    const oct = [];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + Math.PI / 8; oct.push(Math.cos(a) * 21.5, Math.sin(a) * 21.5); }
    glow(g, (p) => p.E(0, 0, 21), col, { blur: 6, core: col });
    solid(g, (p) => p.E(0, 0, 24.5), '#c9d0dc', { hi: 0.5, lo: 0.5, bevel: 1.6 });
    solid(g, (p) => p.E(0, 0, 20), dark(col, 0.42), { hi: 0.25, lo: 0.4, bevel: 2, lw: 1.9, shine: 0.3 });
    g.save();
    g.beginPath();
    pen(g).P(oct.map((v) => v * 0.6));
    g.fillStyle = rgba(col, 0.38);
    g.fill();
    g.restore();
    line(g, (p) => { for (let i = 0; i < 16; i += 2) p.M(oct[i] * 0.93, oct[i + 1] * 0.93).L(oct[i] * 0.6, oct[i + 1] * 0.6); }, rgba('#ffffff', 0.22), 0.9);
    for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + Math.PI / 4; solid(g, (p) => p.E(Math.cos(a) * 22.6, Math.sin(a) * 22.6, 2.3), '#eef2f8', { bevel: 0, lw: 1.4 }); }
    drawGlyph(g, id, '#ffffff', rot(0, 1.16, 0, 0), 2.2);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath();
    g.ellipse(-8.4, -11, 4.4, 2, -0.7, 0, TAU);
    g.fill();
  }

  // 无铭技能宝石：素银的六棱晶柱套两道银箍，正面一圈还没刻字的虚线印记
  function drawBlank(g) {
    const col = G.BLANK_GEM ? G.BLANK_GEM.crystal : '#dfe6f0';
    const body = [0, -27, 11, -16, 11, 12, 0, 24, -11, 12, -11, -16];
    glow(g, (p) => p.P(body), '#e9e2ff', { blur: 8, core: col });
    solid(g, (p) => p.P(body), col, { hi: 0.6, lo: 0.4, shine: 0.55 });
    // 左右两个侧面压暗一点，中间是正面
    g.save();
    g.beginPath();
    pen(g).P([0, -27, -11, -16, -11, 12, 0, 24, -4, 12, -4, -16]);
    g.fillStyle = 'rgba(40,46,70,0.18)';
    g.fill();
    g.beginPath();
    pen(g).P([0, -27, 11, -16, 11, 12, 0, 24, 4, 12, 4, -16]);
    g.fillStyle = 'rgba(40,46,70,0.32)';
    g.fill();
    g.restore();
    line(g, (p) => p.M(0, -27).L(-4, -16).L(-4, 12).L(0, 24).M(0, -27).L(4, -16).L(4, 12).L(0, 24), rgba('#ffffff', 0.55), 0.9);
    // 两道银箍
    // 两道银箍：带一点弧度，像是套在晶柱上
    for (const y of [-10, 8]) solid(g, (p) => p.M(-12.6, y - 2).Q(0, y + 1.4, 12.6, y - 2).L(12.6, y + 1.2).Q(0, y + 4.6, -12.6, y + 1.2).Z(), C.silver, { hi: 0.5, lo: 0.5, bevel: 0.9, lw: 1.6 });
    // 空着的印记：虚线小圆，透着一点珍珠色的光
    glow(g, (p) => p.E(0, -0.6, 2.2), '#e2ccff', { blur: 4, core: rgba('#f4ecff', 0.7) });
    line(g, (p) => p.E(0, -0.6, 3.6), rgba('#7b6fae', 0.95), 1.1, null, [1.5, 1.3]);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.ellipse(-6.4, -12 - 6, 1.6, 3.4, 0.25, 0, TAU);
    g.fill();
    spark(g, 13.5, -20, 5, '#efe6ff');
  }

  // =====================================================================
  // 生成与缓存
  // =====================================================================
  const cache = {}; // key → data URL
  const ruled = {}; // key → 已写进样式表
  let sheet = null;

  function render(draw, shadow) {
    const a = document.createElement('canvas');
    a.width = a.height = PX;
    const g = a.getContext('2d');
    g.setTransform(U, 0, 0, U, PX / 2, PX / 2);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    draw(g);
    if (shadow === 0) return a.toDataURL('image/png');
    // 整体压一层投影，在花哨的底色上也立得住
    const b = document.createElement('canvas');
    b.width = b.height = PX;
    const h = b.getContext('2d');
    h.shadowColor = 'rgba(0,0,0,0.8)';
    h.shadowBlur = 3 * U;
    h.shadowOffsetY = 1.2 * U;
    h.drawImage(a, 0, 0);
    return b.toDataURL('image/png');
  }

  function build(key) {
    const k = key.split('-');
    if (k[0] === 'it') {
      const fn = ITEM_DRAW[k[1]];
      const s = ITEM_SCALE[k[1]] || 1;
      return fn ? render((g) => { g.scale(s, s); fn(g, +k[2] || 0, +k[3] || 0); }) : null;
    }
    if (k[0] === 'cur') {
      const c = G.CURRENCY[k[1]];
      return c && CUR_DRAW[k[1]] ? render((g) => { g.scale(1.1, 1.1); CUR_DRAW[k[1]](g, c.color); }) : null;
    }
    if (k[0] === 'sk') {
      const s = G.SKILLS[k[1]];
      if (s && SKILL_DRAW[k[1]]) return render((g) => SKILL_DRAW[k[1]](g, s.color));
      if (s && USKILL_DRAW[k[1]]) return render((g) => USKILL_DRAW[k[1]](g, s.color));
      if (s && s.basic && BASIC_DRAW[s.rtype]) return render((g) => BASIC_DRAW[s.rtype](g, s.color));
      const wt = s ? wskillType(k[1]) : null;
      if (s && s.uskill && !USKILL_DRAW[k[1]] && WSKILL_DRAW[wt]) return render((g) => { emberFrame(g); g.scale(0.86, 0.86); WSKILL_DRAW[wt](g, s.color); });
      return wt && WSKILL_DRAW[wt] ? render((g) => WSKILL_DRAW[wt](g, s.color || WSKILL_COLOR[wt])) : null;
    }
    // 预览用：按武器类型直接画武器技（不依赖技能 id）
    if (k[0] === 'wsk') return WSKILL_DRAW[k[1]] ? render((g) => WSKILL_DRAW[k[1]](g, WSKILL_COLOR[k[1]])) : null;
    if (k[0] === 'sup') return G.SUPPORTS[k[1]] ? render((g) => drawSupport(g, k[1])) : null;
    if (k[0] === 'blank') return render((g) => { g.scale(1.08, 1.08); drawBlank(g); });
    if (k[0] === 'basicnone') return render((g) => drawBasicBlank(g));
    if (k[0] === 'ail') {
      const a = AIL[k[1]];
      return a ? render((g) => drawGlyph(g, a[0], a[1], rot(0, 2.5, 0, 0), 1.9)) : null;
    }
    return null;
  }

  function url(key) {
    if (!(key in cache)) cache[key] = build(key) || '';
    return cache[key];
  }

  // 保证 .ico-<key> 这条规则存在，返回类名
  function cls(key) {
    if (!ruled[key]) {
      ruled[key] = true;
      if (!sheet) {
        const st = document.createElement('style');
        st.id = 'icon-rules';
        document.head.appendChild(st);
        sheet = st.sheet;
      }
      const u = url(key);
      if (u) sheet.insertRule('.ico-' + key + '{background-image:url(' + u + ') !important}', sheet.cssRules.length);
    }
    return 'ico-' + key;
  }

  // 物品 → 图标键：部位 + 基底 + 名称档次（由 baseName 在基底名单里的位置决定）
  function itemKey(item) {
    const bases = G.BASES[item.slot] || [];
    const bi = G.clamp(item.baseIdx | 0, 0, Math.max(0, bases.length - 1));
    const base = bases[bi];
    const tier = base ? Math.max(0, base.names.indexOf(item.baseName)) : 0;
    return 'it-' + item.slot + '-' + bi + '-' + tier;
  }

  const html = (key, extra) => '<i class="ico ' + cls(key) + (extra ? ' ' + extra : '') + '"></i>';

  // 全部图标键（联络表 / 测试用）
  function keys() {
    const out = [];
    for (const slot of G.SLOTS) {
      G.BASES[slot].forEach((b, bi) => b.names.forEach((n, ti) => out.push('it-' + slot + '-' + bi + '-' + ti)));
    }
    for (const id of G.CUR_IDS) out.push('cur-' + id);
    for (const id of Object.keys(G.SKILLS)) out.push('sk-' + id);
    for (const id of Object.keys(G.SUPPORTS)) out.push('sup-' + id);
    for (const id of Object.keys(AIL)) out.push('ail-' + id);
    out.push('blank');
    return out;
  }

  // 预热：图标本来是第一次用到才画（两张 128 像素的画布 + 投影 + 转成 data URL，都是同步的），
  // 攒到第一次打开背包时会卡一下。启动后趁空闲分批画完：每一批只占几毫秒，不抢游戏的帧。
  let warming = false;
  function warm() {
    if (warming) return;
    warming = true;
    const list = keys();
    let i = 0;
    const idle = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 80 })
      : (fn) => setTimeout(() => fn(null), 30);
    const slice = (deadline) => {
      const t0 = performance.now();
      while (i < list.length) {
        cls(list[i++]);
        // 至少画一个；之后看这一帧还有没有空。一直等不到空闲（超时触发）或没有 deadline 的环境，按 6 毫秒一批
        const idleNow = deadline && deadline.timeRemaining && !deadline.didTimeout;
        if (idleNow ? deadline.timeRemaining() < 4 : performance.now() - t0 > 6) break;
      }
      if (i < list.length) idle(slice);
    };
    idle(slice);
  }

  G.icons = {
    url,
    cls,
    html,
    keys,
    warm,
    ready: () => keys().every((k) => k in cache), // 是否全部画好了（测试用）
    itemKey,
    item: (item, extra) => html(itemKey(item), extra),
    slot: (slot, extra) => html('it-' + slot + '-0-0', extra), // 空装备栏的占位剪影
    cur: (id, extra) => html('cur-' + id, extra),
    skill: (id, extra) => html('sk-' + id, extra),
    sup: (id, extra) => html('sup-' + id, extra),
    ail: (id, extra) => html('ail-' + id, extra),
    blank: (extra) => html('blank', extra), // 无铭技能宝石
    basicBlank: (extra) => html('basicnone', extra), // 武器普攻卡没拿远程武器时的空白图标
    wsk: (type, extra) => html('wsk-' + type, extra), // 按武器类型的武器技图标（技能数据还没有时的退路）
    weaponType, // 武器基底下标 → 'blade' | 'staff' | 'wand' | 'daggers' | 'hammer' | 'bow' | 'katana' | 'banner'
    wskColor: (type) => WSKILL_COLOR[type] || '#e6dfd0',
    supColor: (id) => SUP_TINT[supKey(id)] || '#d8d8e0',
    ally: ALLY,
  };
})();
