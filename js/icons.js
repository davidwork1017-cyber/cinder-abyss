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

  // 各部位的图稿大小不一，统一放大到差不多占满格子
  const ITEM_SCALE = { weapon: 1.2, helm: 1.2, body: 1.17, gloves: 1.2, boots: 1.18, belt: 1.08, ring: 1.3, amulet: 1.1 };
  const ITEM_DRAW = {
    weapon: (g, base, tier) => [drawBlade, drawStaff, drawWand][base](g, tier),
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
  };

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
  };
  const GLYPH_FILL = { fire: 1, light: 1, stagger: 1, ailment: 1, frugal: 1, brutal: 1 }; // 这些符号画成实心
  const SUP_TINT = {
    multi: '#ffb066', pierce: '#b9c6dc', chain: '#ffe45e', expanse: '#7fe0c0', haste: '#7ed67a', fire: '#ff7a2c', cold: '#86d8ff', light: '#ffe45e',
    brutal: '#e2705a', precise: '#ffd75e', leech: '#ff6a8a', echo: '#c7a6ff', stagger: '#f2e6b0', ailment: '#b6e05c', frugal: '#6fb2ff',
  };
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
      return s && SKILL_DRAW[k[1]] ? render((g) => SKILL_DRAW[k[1]](g, s.color)) : null;
    }
    if (k[0] === 'sup') return G.SUPPORTS[k[1]] ? render((g) => drawSupport(g, k[1])) : null;
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
    supColor: (id) => SUP_TINT[id] || '#d8d8e0',
  };
})();
