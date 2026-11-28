// map-open（实验）：开放式地图。只有网址带 ?openmap=1 才加载这个文件（index.html），默认不加载、不改任何行为。
// 第 1 区（灰烬荒原）的地形换成 GEN.open：一整片连着的荒原，而不是房间 + 走廊。
//
// 做法：在 ~180 × 150 m 的场地上撒点、切 Voronoi 格子，每个格子是 spec 里的一个「房间」（寻路 W.navNext、刷怪、宝箱、异兆照旧按房间工作），
// 相邻格子之间的边界大多敞开（门 = 边界上离障碍最远的点），所以走起来是一整片地；地形负责塑形：
//   - 几块格子整块抬成岩台（不可走），边上用一串圆形岩块咬出不规则的轮廓；
//   - 一条熔岩河沿 Voronoi 边从西到东横穿，只留两座石桥；
//   - 一道岩脊从岩台或场地边伸进来，挡出不同的路线；
//   - 格子里零星的岩块、枯树、残墙（小，避开门和格子芯，不卡寻路）。
// 起点在南边一个半圆的凹口（路标石在旁边），首领场地在北边一道关口后面，场地后面立着最高的地标（烬塔）。
// 布局只用种子随机源 R（= mulberry32(seed)，和其它生成器一样），外观只用 zone.vseed 起的伪随机，不碰 Math.random。
(function () {
  'use strict';
  const T = THREE;
  const W = G.world, L = W._terrLab();
  const { GEN, ZONE_TERRAIN, MAT, primSd, mulberry32, lvFor } = L;
  const TAU = Math.PI * 2;
  G.openMap = true;

  const OPEN = {
    fw: [158, 174], fh: [166, 182], // 场地（不含起点凹口、首领场地）：纵深比宽度大一点，主路线更长
    sp: 21, // 撒点间距
    mesa: 0.18, // 抬成岩台的格子比例
    river: [3.0, 3.8], // 熔岩河半宽
    bridgeW: 5.5,
    ridge: [2.4, 3.0], // 岩脊半宽
    minEdge: 7, // 比这短的公共边不算相邻（太窄，算角）
    door: 2.4, // 门的最小净宽（半宽）
    startR: 8.2, arenaR: 15,
    packArea: 600, // 每多少 m² 一群
    check: { box: 290, areaMin: 9000, areaMax: 30000, gap: 0, packStart: 18 },
  };
  W.openCfg = OPEN;

  // ---------- 小工具 ----------
  const v2 = (x, z) => ({ x, z });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  function polyArea(P) {
    let a = 0;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j].x + P[i].x) * (P[j].z - P[i].z);
    return Math.abs(a) / 2;
  }
  function segDist(px, pz, a, b) {
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((px - a.x) * ex + (pz - a.z) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - a.x - ex * t, pz - a.z - ez * t);
  }
  function inPoly(P, x, z) {
    let ins = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) ins = !ins;
    }
    return ins;
  }
  // 半平面裁剪（保留 nx·x + nz·z ≤ c），tags[k] = 边 k→k+1 的邻居（负数 = 场地边）
  function clipPoly(P, T, nx, nz, c, tag) {
    const out = [], ot = [], n = P.length;
    for (let k = 0; k < n; k++) {
      const a = P[k], b = P[(k + 1) % n], da = nx * a.x + nz * a.z - c, db = nx * b.x + nz * b.z - c;
      const I = () => {
        const t = da / (da - db);
        return v2(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      };
      if (da <= 0) {
        out.push(a);
        if (db > 0) {
          ot.push(T[k]);
          out.push(I());
          ot.push(tag);
        } else ot.push(T[k]);
      } else if (db <= 0) {
        out.push(I());
        ot.push(T[k]);
      }
    }
    return { P: out, T: ot };
  }
  // Chaikin 平滑（端点不动）
  function chaikin(pts, it) {
    let p = pts;
    for (let k = 0; k < it; k++) {
      const q = [p[0]];
      for (let i = 0; i + 1 < p.length; i++) {
        const a = p[i], b = p[i + 1];
        q.push(v2(a.x * 0.75 + b.x * 0.25, a.z * 0.75 + b.z * 0.25), v2(a.x * 0.25 + b.x * 0.75, a.z * 0.25 + b.z * 0.75));
      }
      q.push(p[p.length - 1]);
      p = q;
    }
    return p;
  }

  // ---------- 生成器 ----------
  function openGen(R, def) {
    const sub = (R() * 4294967296) >>> 0;
    let last = null;
    for (let att = 0; att < 24; att++) {
      const r = mulberry32((sub + Math.imul(att, 0x9e3779b1)) >>> 0);
      const out = openTry(r, def);
      if (out.ok) return out.spec;
      last = out.why;
    }
    throw new Error('open: 24 次都没摆成（' + last + '）');
  }
  openGen.check = OPEN.check;

  function openTry(R, def) {
    const rnd = (a, b) => a + R() * (b - a);
    const fail = (why) => ({ ok: false, why });
    const FW = rnd(OPEN.fw[0], OPEN.fw[1]), FH = rnd(OPEN.fh[0], OPEN.fh[1]);
    const X0 = -FW / 2, X1 = FW / 2, Z0 = -FH / 2, Z1 = FH / 2;
    // 1. 撒点（抖动网格）
    const cols = Math.round(FW / OPEN.sp), rows = Math.round(FH / OPEN.sp), cw = FW / cols, ch = FH / rows;
    const sites = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) sites.push(v2(X0 + (i + 0.5 + (R() - 0.5) * 0.62) * cw, Z0 + (j + 0.5 + (R() - 0.5) * 0.62) * ch));
    const N = sites.length;
    // 2. Voronoi 格子（场地矩形裁剪）。场地边的 tag：-1 南、-2 东、-3 北、-4 西
    const cells = sites.map((s, i) => {
      let P = [v2(X0, Z0), v2(X1, Z0), v2(X1, Z1), v2(X0, Z1)], T = [-1, -2, -3, -4];
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const o = sites[j];
        if (Math.abs(o.x - s.x) > OPEN.sp * 3 || Math.abs(o.z - s.z) > OPEN.sp * 3) continue;
        const nx = o.x - s.x, nz = o.z - s.z, c = nx * (s.x + o.x) * 0.5 + nz * (s.z + o.z) * 0.5;
        const q = clipPoly(P, T, nx, nz, c, j);
        P = q.P;
        T = q.T;
      }
      let inR = 1e9;
      for (let k = 0; k < P.length; k++) inR = Math.min(inR, segDist(s.x, s.z, P[k], P[(k + 1) % P.length]));
      return { id: i, site: s, P, T, area: polyArea(P), inR, alive: true, kind: 'cell', tags: [] };
    });
    // 公共边
    const edges = new Map(); // key 'a,b'（a < b）→ { a, b, p0, p1, len }
    const eKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
    for (const c of cells) {
      for (let k = 0; k < c.P.length; k++) {
        const t = c.T[k];
        if (t < 0 || t < c.id) continue;
        const p0 = c.P[k], p1 = c.P[(k + 1) % c.P.length];
        edges.set(eKey(c.id, t), { a: c.id, b: t, p0, p1, len: dist(p0, p1), block: null });
      }
    }
    const nbrs = (i) => {
      const out = [];
      for (const e of edges.values()) if (e.len >= OPEN.minEdge && (e.a === i || e.b === i)) out.push(e.a === i ? e.b : e.a);
      return out;
    };
    const sideSeg = (c, tag) => {
      for (let k = 0; k < c.P.length; k++) if (c.T[k] === tag) return [c.P[k], c.P[(k + 1) % c.P.length]];
      return null;
    };
    // 3. 起点格（南边）和首领格（北边）
    const tx = (R() < 0.5 ? -1 : 1) * rnd(0.12, 0.32) * FW; // 起点偏一侧
    let sc = null, sSeg = null, best = 1e9;
    for (const c of cells) {
      const s = sideSeg(c, -1);
      if (!s || dist(s[0], s[1]) < 17) continue;
      const mx = (s[0].x + s[1].x) / 2, v = Math.abs(mx - tx);
      if (v < best) (best = v), (sc = c), (sSeg = s);
    }
    if (!sc) return fail('没有起点格');
    const bx = -Math.sign(tx) * rnd(0.12, 0.34) * FW; // 首领在对侧：斜穿整张图
    let bc = null, bSeg = null;
    best = 1e9;
    for (const c of cells) {
      const s = sideSeg(c, -3);
      if (!s || dist(s[0], s[1]) < 14) continue;
      const mx = (s[0].x + s[1].x) / 2, v = Math.abs(mx - bx);
      if (v < best) (best = v), (bc = c), (bSeg = s);
    }
    if (!bc) return fail('没有首领格');
    const keep = new Set([sc.id, bc.id].concat(nbrs(sc.id), nbrs(bc.id)));
    const aliveConnected = () => {
      const seen = new Set([sc.id]), q = [sc.id];
      while (q.length) {
        const u = q.pop();
        for (const e of edges.values()) {
          if (e.block || e.len < OPEN.minEdge || (e.a !== u && e.b !== u)) continue;
          const v = e.a === u ? e.b : e.a;
          if (!cells[v].alive || seen.has(v)) continue;
          seen.add(v);
          q.push(v);
        }
      }
      return seen;
    };
    // 4. 岩台：随机挑格子抬起来，始终保持连通
    // 岩台优先挑不贴场地边的格子（场地中间的岩台塑形更有意思），贴边的排在后面
    const interior = (c) => c.T.every((t) => t >= 0);
    const inner = L.shuffleR(cells.filter(interior).map((c) => c.id), R), edge = L.shuffleR(cells.filter((c) => !interior(c)).map((c) => c.id), R);
    const order = [];
    while (inner.length || edge.length) order.push(...(R() < 0.33 && edge.length ? edge.splice(0, 1) : inner.length ? inner.splice(0, 1) : edge.splice(0, 1)));
    let nMesa = Math.round(N * OPEN.mesa);
    for (const id of order) {
      if (nMesa <= 0) break;
      if (keep.has(id)) continue;
      cells[id].alive = false;
      const seen = aliveConnected();
      if (cells.some((c) => c.alive && !seen.has(c.id))) {
        cells[id].alive = true;
        continue;
      }
      cells[id].kind = 'mesa';
      nMesa--;
    }
    // 5. Voronoi 顶点图（熔岩河、岩脊沿它走）
    const vk = (p) => Math.round(p.x * 20) + ',' + Math.round(p.z * 20);
    const verts = new Map(); // key → { p, adj: [{ to, e }] }
    const vOf = (p) => {
      const k = vk(p);
      if (!verts.has(k)) verts.set(k, { k, p, adj: [] });
      return verts.get(k);
    };
    for (const e of edges.values()) {
      const A = vOf(e.p0), B = vOf(e.p1);
      A.adj.push({ to: B, e });
      B.adj.push({ to: A, e });
      e.va = A;
      e.vb = B;
    }
    const onSide = (p, side) => (side === 'W' ? p.x < X0 + 0.05 : side === 'E' ? p.x > X1 - 0.05 : side === 'N' ? p.z > Z1 - 0.05 : p.z < Z0 + 0.05);
    // 场地边上的顶点（裁剪出来的）不在公共边里时也要能当起点：把场地边上的格子顶点并进来
    for (const c of cells) for (const p of c.P) if (onSide(p, 'W') || onSide(p, 'E') || onSide(p, 'N') || onSide(p, 'S')) vOf(p);
    // Dijkstra（多源），cost(e) 返回 Infinity 表示不能走
    function vPath(srcs, isDst, cost) {
      const D = new Map(), prev = new Map(), done = new Set();
      for (const s of srcs) D.set(s.k, 0);
      for (;;) {
        let u = null, du = Infinity;
        for (const [k, d] of D) if (!done.has(k) && d < du) (du = d), (u = k);
        if (u === null) return null;
        done.add(u);
        const V = verts.get(u);
        if (isDst(V)) {
          const path = [V];
          let k = u;
          while (prev.has(k)) {
            const pr = prev.get(k);
            path.push(pr.v);
            k = pr.v.k;
          }
          return path.reverse().map((v, i, a) => ({ v, e: i ? prev.get(v.k).e : null }));
        }
        for (const { to, e } of V.adj) {
          if (done.has(to.k)) continue;
          const w = cost(e, V, to);
          if (!(w < Infinity)) continue;
          const nd = du + w;
          if (!D.has(to.k) || nd < D.get(to.k)) {
            D.set(to.k, nd);
            prev.set(to.k, { v: V, e });
          }
        }
      }
    }
    const touches = (e, id) => e.a === id || e.b === id;
    // 6. 熔岩河：西 → 东，大致在起点和首领中间，不贴起点 / 首领格
    const zt = (sc.site.z + bc.site.z) / 2 + rnd(-0.08, 0.08) * FH;
    const noise = new Map();
    for (const e of edges.values()) noise.set(e, rnd(0.75, 1.35));
    const rv = vPath([...verts.values()].filter((v) => onSide(v.p, 'W')), (v) => onSide(v.p, 'E'), (e, A, B) => {
      if (touches(e, sc.id) || touches(e, bc.id)) return Infinity;
      if (!cells[e.a].alive && !cells[e.b].alive) return e.len * 0.6; // 沿岩台里面走（看不见，便宜）
      const mz = (A.p.z + B.p.z) / 2;
      return e.len * noise.get(e) * (1 + (4 * Math.abs(mz - zt)) / FH);
    });
    if (!rv || rv.length < 5) return fail('熔岩河找不到路');
    const rEdges = rv.filter((s) => s.e).map((s) => s.e);
    // 过河点：两条两边都可走、够长的边，沿河 25–45% 和 55–80% 各一座
    const rLen = rEdges.reduce((a, e) => a + e.len, 0);
    let acc = 0;
    const cand = [[], []];
    for (const e of rEdges) {
      const mid = (acc + e.len / 2) / rLen;
      acc += e.len;
      if (!cells[e.a].alive || !cells[e.b].alive || e.len < 9) continue;
      if (mid > 0.2 && mid < 0.46) cand[0].push(e);
      if (mid > 0.54 && mid < 0.82) cand[1].push(e);
    }
    if (!cand[0].length || !cand[1].length) return fail('熔岩河没有过河点');
    const bridges = cand.map((c) => c[Math.floor(R() * c.length)]);
    for (const e of rEdges) e.block = bridges.indexOf(e) >= 0 ? null : 'lava';
    for (const e of bridges) e.bridge = true;
    // 河的折线：顶点链 + 两头伸出场地，平滑
    const rp = rv.map((s) => v2(s.v.p.x, s.v.p.z));
    rp.unshift(v2(rp[0].x - 8, rp[0].z));
    rp.push(v2(rp[rp.length - 1].x + 8, rp[rp.length - 1].z));
    const rs = chaikin(rp, 2);
    // 7. 岩脊：从一块岩台或东西场地边伸进来 3–5 条边（不碰河、起点、首领格）
    const rvSet = new Set(rv.map((s) => s.v.k));
    const ridgeSrc = [...verts.values()].filter((v) => !rvSet.has(v.k) && (v.adj.some((a) => !cells[a.e.a].alive || !cells[a.e.b].alive) || onSide(v.p, 'W') || onSide(v.p, 'E')) && Math.abs(v.p.z - zt) > 22);
    let ridge = null;
    for (let t = 0; t < 30 && !ridge; t++) {
      const s0 = ridgeSrc[Math.floor(R() * ridgeSrc.length)];
      if (!s0) break;
      const chain = [s0], used = [];
      let cur = s0;
      const want = 3 + Math.floor(R() * 3);
      for (let k = 0; k < want; k++) {
        const opts = cur.adj.filter((a) => !rvSet.has(a.to.k) && chain.indexOf(a.to) < 0 && cells[a.e.a].alive && cells[a.e.b].alive && !a.e.block && !touches(a.e, sc.id) && !touches(a.e, bc.id) && a.e.len >= 6);
        if (!opts.length) break;
        const a = opts[Math.floor(R() * opts.length)];
        chain.push(a.to);
        used.push(a.e);
        cur = a.to;
      }
      if (used.length < 3) continue;
      for (const e of used) e.block = 'ridge';
      const seen = aliveConnected();
      if (cells.some((c) => c.alive && !seen.has(c.id))) {
        for (const e of used) e.block = null;
        continue;
      }
      ridge = { pts: chain.map((v) => v2(v.p.x, v.p.z)), edges: used };
    }
    // 8. 连通 + 死路：到不了的格子抬成岩台；只剩一扇门的格子（死路）最多留 1 个（放宝箱），其余抬成岩台
    for (let it = 0; it < 40; it++) {
      const seen = aliveConnected();
      let changed = false;
      for (const c of cells) {
        if (c.alive && !seen.has(c.id)) {
          c.alive = false;
          c.kind = 'mesa';
          changed = true;
        }
      }
      const deg = (id) => nbrs(id).filter((j) => cells[j].alive && !edges.get(eKey(id, j)).block).length;
      const dead = cells.filter((c) => c.alive && c !== sc && c !== bc && deg(c.id) <= 1);
      if (dead.length > 1) {
        // 留离起点最远的那个（宝箱），其余抬起来
        dead.sort((a, b) => dist(b.site, sc.site) - dist(a.site, sc.site));
        for (const c of dead.slice(1)) {
          c.alive = false;
          c.kind = 'mesa';
        }
        changed = true;
      }
      if (!changed) break;
    }
    let live = cells.filter((c) => c.alive);
    for (const c of live) c.grow = c.T.map((t) => t >= 0 && cells[t].alive);
    if (live.length < 24) return fail('可走格子太少 ' + live.length);
    if (bridges.some((e) => !cells[e.a].alive || !cells[e.b].alive)) return fail('石桥一头被抬成了岩台');
    // 9. 挖空（障碍）
    const cuts = [], feats = [];
    // 熔岩河：分段的 path（每段 ≤ 5 个点），桥的位置断开
    const rhw = rs.map(() => rnd(OPEN.river[0], OPEN.river[1]));
    const sAt = [0];
    for (let i = 1; i < rs.length; i++) sAt.push(sAt[i - 1] + dist(rs[i], rs[i - 1]));
    const gaps = bridges.map((e) => {
      const m = v2((e.p0.x + e.p1.x) / 2, (e.p0.z + e.p1.z) / 2);
      let bi = 0, bd = 1e9, bt = 0;
      for (let i = 0; i + 1 < rs.length; i++) {
        const a = rs[i], b = rs[i + 1], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
        let t = l2 > 0 ? ((m.x - a.x) * ex + (m.z - a.z) * ez) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(m.x - a.x - ex * t, m.z - a.z - ez * t);
        if (d < bd) (bd = d), (bi = i), (bt = t);
      }
      const s = sAt[bi] + bt * (sAt[bi + 1] - sAt[bi]);
      const a = rs[bi], b = rs[bi + 1], ang = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
      const hw = rhw[bi];
      const cx = a.x + (b.x - a.x) * bt, cz = a.z + (b.z - a.z) * bt;
      e.door = v2(cx, cz);
      feats.push({ kind: 'bridge', x: cx, z: cz, ang, len: 2 * hw + 2.6, w: OPEN.bridgeW });
      const gh = OPEN.bridgeW / 2 + hw + 0.4; // path 的端头是半径 hw 的圆帽：缺口两边各让出 hw
      return [s - gh, s + gh];
    });
    const atS = (s) => {
      for (let i = 0; i + 1 < rs.length; i++) {
        if (s <= sAt[i + 1] || i === rs.length - 2) {
          const t = (s - sAt[i]) / Math.max(1e-6, sAt[i + 1] - sAt[i]);
          return { p: [rs[i].x + (rs[i + 1].x - rs[i].x) * t, rs[i].z + (rs[i + 1].z - rs[i].z) * t], hw: rhw[i] + (rhw[i + 1] - rhw[i]) * t };
        }
      }
      return null;
    };
    {
      const pieces = [];
      let cur = [];
      const pushPt = (q) => cur.push(q);
      for (let i = 0; i < rs.length; i++) {
        for (const g of gaps) {
          if (i > 0 && g[0] > sAt[i - 1] && g[0] <= sAt[i]) {
            pushPt(atS(g[0]));
            pieces.push(cur);
            cur = [atS(g[1])];
          }
        }
        if (!gaps.some((g) => sAt[i] > g[0] && sAt[i] < g[1])) pushPt({ p: [rs[i].x, rs[i].z], hw: rhw[i] });
      }
      pieces.push(cur);
      for (const pc of pieces) {
        for (let i = 0; i + 1 < pc.length; i += 4) {
          const part = pc.slice(i, i + 5);
          if (part.length < 2) continue;
          cuts.push({ prim: { t: 'path', pts: part.map((q) => q.p.slice()), hw: part.map((q) => q.hw) }, mat: MAT.LAVA });
        }
      }
    }
    feats.push({ kind: 'river', pts: rs.map((p) => [p.x, p.z]), hw: rhw });
    // 岩脊
    if (ridge) {
      const rr = chaikin(ridge.pts, 1);
      for (let i = 0; i + 1 < rr.length; i++) {
        const a = rr[i], b = rr[i + 1];
        cuts.push({ prim: { t: 'capsule', ax: a.x, az: a.z, bx: b.x, bz: b.z, hw: rnd(OPEN.ridge[0], OPEN.ridge[1]) }, mat: MAT.ROCK });
      }
      feats.push({ kind: 'ridge', pts: rr.map((p) => [p.x, p.z]) });
    }
    // 起点凹口、首领关口 + 场地（场地外面）
    const smx = (sSeg[0].x + sSeg[1].x) / 2, start = v2(smx, Z0 - 4);
    const amx = Math.max(Math.min(bSeg[0].x, bSeg[1].x) + 5, Math.min(Math.max(bSeg[0].x, bSeg[1].x) - 5, (bSeg[0].x + bSeg[1].x) / 2));
    const arenaC = v2(amx, Z1 + 9 + OPEN.arenaR - 1);
    const avoidJag = (x, z, m) => Math.hypot(x - start.x, z - start.z) < OPEN.startR + 6 + m || (Math.abs(x - amx) < 9 + m && z > Z1 - 10) || feats.some((f) => f.kind === 'bridge' && Math.hypot(f.x - x, f.z - z) < 7 + m);
    const phase = rnd(0, 100);
    // 岩台和场地边：一串圆形岩块咬进可走格子 1.5–4 m（打破 Voronoi 的直边）
    for (const c of live) {
      for (let k = 0; k < c.P.length; k++) {
        const t = c.T[k];
        const outer = t < 0 || !cells[t].alive || (edges.get(eKey(c.id, t)) && edges.get(eKey(c.id, t)).len < OPEN.minEdge && false);
        if (!outer) continue;
        const a = c.P[k], b = c.P[(k + 1) % c.P.length], l = dist(a, b);
        if (l < 1) continue;
        const ux = (b.x - a.x) / l, uz = (b.z - a.z) / l;
        // 外法线：背向格子芯
        let nx = uz, nz = -ux;
        if ((c.site.x - a.x) * nx + (c.site.z - a.z) * nz > 0) (nx = -nx), (nz = -nz);
        const onRect = t < 0;
        for (let s = rnd(1, 4); s < l; s += rnd(4.2, 6.5)) {
          // 场地矩形边：按沿边的低频噪声咬进 2–10 m（边线起伏，不是一条直线）；岩台边：1.2–3.8 m
          const wx = a.x + ux * s, wz = a.z + uz * s;
          const nz0 = onRect ? L.vnoise(wx * 0.04 + phase, wz * 0.04 - phase) * 0.65 + L.vnoise(wx * 0.11 - phase, wz * 0.11 + phase) * 0.35 : 0;
          const intr = onRect ? 1.5 + (12 * Math.max(0, nz0 - 0.28)) / 0.72 + rnd(-0.6, 0.6) : rnd(1.2, 3.8);
          const rr = onRect ? Math.max(3, Math.min(9, intr * 0.75 + rnd(1, 2.5))) : rnd(2.2, 4.6), off = rr - intr;
          const x = a.x + ux * s + nx * off, z = a.z + uz * s + nz * off;
          if (avoidJag(x, z, rr) || Math.hypot(x - c.site.x, z - c.site.z) < rr + 6.5) continue;
          cuts.push({ prim: { t: 'circle', x, z, r: rr }, mat: MAT.ROCK });
        }
      }
    }
    // 场地四角：大岩块把直角磨圆
    for (const [cx, cz] of [[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]]) {
      const rr = rnd(11, 17);
      if (!avoidJag(cx, cz, rr)) cuts.push({ prim: { t: 'circle', x: cx + Math.sign(-cx) * rnd(0, 3), z: cz + Math.sign(-cz) * rnd(0, 3), r: rr }, mat: MAT.ROCK });
    }
    // 关口两侧的岩柱（门柱）
    for (const s of [-1, 1]) cuts.push({ prim: { t: 'circle', x: amx + s * 6.4, z: Z1 + 2, r: 2.3 }, mat: MAT.ROCK });
    const cutSd = (x, z) => {
      let d = 1e9;
      for (const c of cuts) d = Math.min(d, -primSd(c.prim, x, z));
      return d; // > 0：在挖空外面多远
    };
    // 门：公共边上离挖空最远的点（9 个采样）
    for (const e of edges.values()) {
      if (e.block || e.len < OPEN.minEdge || !cells[e.a].alive || !cells[e.b].alive) continue;
      if (e.door) continue;
      let bd = -1e9, bp = null;
      for (let k = 1; k <= 9; k++) {
        const t = k / 10, x = e.p0.x + (e.p1.x - e.p0.x) * t, z = e.p0.z + (e.p1.z - e.p0.z) * t, d = cutSd(x, z);
        const v = Math.min(d, Math.min(t, 1 - t) * e.len);
        if (v > bd) (bd = v), (bp = v2(x, z));
      }
      if (bd < OPEN.door) {
        e.block = 'narrow';
        continue;
      }
      e.door = bp;
    }
    // 被边上的岩块咬掉门 / 咬掉芯的格子：芯挪到格子里离挖空最远的点；到不了起点的格子抬成岩台（重新算外扩）
    for (const c of live) {
      c.core = c.site;
      if (cutSd(c.site.x, c.site.z) >= 3) continue;
      let bv = -1e9, bp = null;
      for (let t = 0; t < 60; t++) {
        const a = R() * TAU, d = R() * c.inR * 1.3, x = c.site.x + Math.sin(a) * d, z = c.site.z + Math.cos(a) * d;
        if (!inPoly(c.P, x, z)) continue;
        const v = cutSd(x, z);
        if (v > bv) (bv = v), (bp = v2(x, z));
      }
      if (!bp || bv < 2.6) c.alive = false;
      else c.core = bp;
    }
    {
      const seen = new Set([sc.id]), q = [sc.id];
      while (q.length) {
        const u = q.pop();
        for (const e of edges.values()) {
          if (!e.door || e.block || (e.a !== u && e.b !== u)) continue;
          const v = e.a === u ? e.b : e.a;
          if (!cells[v].alive || seen.has(v)) continue;
          seen.add(v);
          q.push(v);
        }
      }
      for (const c of live) if (!seen.has(c.id)) c.alive = false;
    }
    if (!sc.alive || !bc.alive) return fail('起点格 / 首领格被咬掉了');
    if (bridges.some((e) => !cells[e.a].alive || !cells[e.b].alive)) return fail('石桥一头的格子没了');
    live = live.filter((c) => c.alive);
    for (const c of live) c.grow = c.T.map((t) => t >= 0 && cells[t].alive);
    // 10. 房间：起点凹口（0）、各格子、关口、场地
    const rooms = [], links = [];
    rooms.push({ id: 0, kind: 'start', order: 0, path: true, prims: [{ t: 'circle', x: start.x, z: start.z, r: OPEN.startR }], core: { x: start.x, z: start.z, r: 8 }, tags: [] });
    const rid = new Map();
    for (const c of live) {
      rid.set(c.id, rooms.length);
      rooms.push({ id: rooms.length, kind: 'side', order: 0, path: false, prims: [{ t: OPEN.cpoly === false ? 'poly' : 'cpoly', pts: grow(c), round: 0.3 }], core: { x: c.core.x, z: c.core.z, r: Math.max(7, Math.min(11, c.inR * 0.9)) }, tags: [], cell: c.id });
    }
    const gateA = v2(amx, Z1 - 3), gateB = v2(amx, arenaC.z - OPEN.arenaR + 1);
    const gid = rooms.length;
    rooms.push({ id: gid, kind: 'link', order: 0, path: true, prims: [{ t: 'capsule', ax: gateA.x, az: gateA.z, bx: gateB.x, bz: gateB.z, hw: 4.2 }], core: { x: amx, z: Z1 + 4, r: 4.2 }, axis: [[gateA.x, gateA.z], [gateB.x, gateB.z]], ends: [rid.get(bc.id), gid + 1], tags: [] });
    const aid = rooms.length;
    rooms.push({ id: aid, kind: 'arena', order: 0, path: true, prims: [{ t: 'circle', x: arenaC.x, z: arenaC.z, r: OPEN.arenaR }], core: { x: arenaC.x, z: arenaC.z, r: OPEN.arenaR }, tags: [] });
    // 11. 格子里的小障碍：岩块、枯树、残墙（避开门、格子芯、门之间的连线）
    const doorsOf = (cid) => {
      const out = [];
      for (const e of edges.values()) if (e.door && !e.block && (e.a === cid || e.b === cid)) out.push(e.door);
      return out;
    };
    for (const c of live) {
      const ds = doorsOf(c.id), rm = rooms[rid.get(c.id)];
      const clear = (x, z, m) => {
        if (!inPoly(c.P, x, z)) return false;
        if (Math.hypot(x - c.site.x, z - c.site.z) < 5 + m) return false;
        for (const d of ds) {
          if (Math.hypot(d.x - x, d.z - z) < 6 + m) return false;
          if (segDist(x, z, c.site, d) < m + 2.6) return false;
        }
        if (Math.hypot(x - start.x, z - start.z) < 14 + m) return false;
        return cutSd(x, z) > m + 2.5;
      };
      const tries = (m, fn, n) => {
        for (let t = 0; t < 14 && n > 0; t++) {
          const a = R() * TAU, d = rnd(0.35, 0.95) * c.inR + rnd(0, 6), x = c.site.x + Math.sin(a) * d, z = c.site.z + Math.cos(a) * d;
          if (!clear(x, z, m)) continue;
          fn(x, z, a);
          n--;
        }
      };
      const roll = R();
      if (roll < 0.42) tries(3.2, (x, z) => cuts.push({ prim: { t: 'circle', x, z, r: rnd(1.6, 3.0) }, mat: MAT.ROCK }), 1 + (R() < 0.35 ? 1 : 0));
      else if (roll < 0.66) tries(1.4, (x, z) => (cuts.push({ prim: { t: 'circle', x, z, r: 0.9 }, mat: MAT.ROCK }), feats.push({ kind: 'tree', x, z, r: 1.3 })), 1);
      else if (roll < 0.84) tries(1.4, (x, z) => { const tr = rnd(0.55, 0.8); cuts.push({ prim: { t: 'circle', x, z, r: tr }, mat: MAT.ROCK }); feats.push({ kind: 'trunk', x, z, r: tr }); }, 2 + Math.floor(R() * 2));
      else {
        // 残墙：一两段矮墙（WALL），这一格记为「废墟」
        tries(3.4, (x, z, a) => {
          const ang = a + rnd(-0.4, 0.4), hz = rnd(1.8, 3.0);
          cuts.push({ prim: { t: 'rbox', x, z, hx: 0.45, hz, ang, round: 0.1 }, mat: MAT.WALL });
          feats.push({ kind: 'wall', x, z, ang, hx: 0.45, hz });
        }, 2);
        rm.tags.push('ruin');
      }
    }
    // 12. 连接（房间图）
    for (const e of edges.values()) {
      if (!e.door || e.block || !cells[e.a].alive || !cells[e.b].alive) continue;
      links.push({ a: rid.get(e.a), b: rid.get(e.b), door: { x: e.door.x, z: e.door.z }, kind: e.bridge ? 'bridge' : 'open' });
    }
    const sRoom = rid.get(sc.id), bRoom = rid.get(bc.id);
    const sDoor = v2(start.x, Z0 + 0.5);
    links.push({ a: 0, b: sRoom, door: { x: sDoor.x, z: sDoor.z }, kind: 'open' });
    links.push({ a: bRoom, b: gid, door: { x: amx, z: Z1 - 1 }, kind: 'corr' }, { a: gid, b: aid, door: { x: amx, z: arenaC.z - OPEN.arenaR }, kind: 'corr' });
    // 13. 主路线（起点 → 首领）：房间图上的最短路；其余格子按离主路线最近的那格定 order
    const n = rooms.length, adj = rooms.map(() => []);
    for (const lk of links) {
      const A = rooms[lk.a].core, B = rooms[lk.b].core, d = lk.door;
      const w = Math.hypot(A.x - d.x, A.z - d.z) + Math.hypot(B.x - d.x, B.z - d.z);
      adj[lk.a].push([lk.b, w]);
      adj[lk.b].push([lk.a, w]);
    }
    const dij = (srcs) => {
      const D = new Float64Array(n).fill(Infinity), P = new Int32Array(n).fill(-1), S = new Int32Array(n).fill(-1), done = new Uint8Array(n);
      for (const s of srcs) (D[s] = 0), (S[s] = s);
      for (;;) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!done[i] && D[i] < Infinity && (u < 0 || D[i] < D[u])) u = i;
        if (u < 0) break;
        done[u] = 1;
        for (const [v, w] of adj[u]) if (D[u] + w < D[v]) (D[v] = D[u] + w), (P[v] = u), (S[v] = S[u]);
      }
      return { D, P, S };
    };
    const d0 = dij([0]);
    if (!(d0.D[aid] < Infinity)) return fail('到不了首领场地');
    const route = [];
    for (let k = aid; k >= 0; k = d0.P[k]) route.push(k);
    route.reverse(); // [0, 格子…, 关口, 场地]
    const cellsOnRoute = route.filter((k) => k !== 0 && k !== gid && k !== aid);
    if (cellsOnRoute.length < 5) return fail('主路线太短');
    cellsOnRoute.forEach((k, i) => {
      rooms[k].kind = 'room';
      rooms[k].path = true;
      rooms[k].order = i + 1;
    });
    const nR = cellsOnRoute.length;
    rooms[gid].order = nR;
    rooms[aid].order = nR + 1;
    const dr = dij(cellsOnRoute);
    for (const rm of rooms) if (rm.kind === 'side') rm.order = rooms[dr.S[rm.id]] ? rooms[dr.S[rm.id]].order : 1;
    const nPath = nR + 2;
    for (const rm of rooms) rm.lv = lvFor(rm.order, nPath);
    // 死路格（只有一扇门的 side）：放宝箱
    const degR = rooms.map(() => 0);
    for (const lk of links) (degR[lk.a]++), (degR[lk.b]++);
    if (rooms.filter((rm) => rm.kind === 'side' && degR[rm.id] <= 1).length > 1) return fail('死路多于 1 条');
    // 14. 兴趣点：营地 2–3 个（离主路线远的 side 格）、宝箱、路标石、地标
    const chests = [], packs = [];
    const sideRooms = rooms.filter((rm) => rm.kind === 'side');
    const farness = (rm) => Math.min(...cellsOnRoute.map((k) => Math.hypot(rooms[k].core.x - rm.core.x, rooms[k].core.z - rm.core.z)));
    const camps = [];
    for (const rm of sideRooms.slice().sort((a, b) => farness(b) - farness(a))) {
      if (camps.length >= 3) break;
      if (camps.some((c) => Math.hypot(c.core.x - rm.core.x, c.core.z - rm.core.z) < 45)) continue;
      if (rm.tags.indexOf('ruin') >= 0) continue;
      camps.push(rm);
      rm.tags.push('camp');
    }
    const POI = [];
    // 宝箱放在格子靠外的一侧（离门远），朝格子芯
    const chestIn = (rm) => {
      const c = cells[rm.cell], ds = doorsOf(c.id);
      let bestP = null, bv = -1;
      for (let t = 0; t < 40; t++) {
        const a = R() * TAU, d = rnd(0.4, 1.0) * c.inR + 2, x = c.site.x + Math.sin(a) * d, z = c.site.z + Math.cos(a) * d;
        if (!inPoly(c.P, x, z) || cutSd(x, z) < 2.2) continue;
        const v = Math.min(...ds.map((q) => Math.hypot(q.x - x, q.z - z)), 30);
        if (v > bv) (bv = v), (bestP = v2(x, z));
      }
      if (!bestP) return null;
      const ch = { x: bestP.x, z: bestP.z, room: rm.id, ang: Math.atan2(rm.core.x - bestP.x, rm.core.z - bestP.z) };
      chests.push(ch);
      return ch;
    };
    for (const rm of camps) {
      chestIn(rm);
      POI.push({ kind: 'camp', x: rm.core.x, z: rm.core.z, room: rm.id });
      feats.push({ kind: 'camp', x: rm.core.x, z: rm.core.z, r: 5, room: rm.id });
    }
    for (const rm of rooms) {
      if (rm.kind === 'side' && degR[rm.id] === 1) {
        rm.tags.push('spur');
        if (!chests.some((c) => c.room === rm.id)) chestIn(rm);
      }
    }
    const ruins = rooms.filter((rm) => rm.tags.indexOf('ruin') >= 0);
    if (ruins.length) chestIn(ruins[Math.floor(R() * ruins.length)]);
    // 路标石：起点格里，离起点 11–13 m
    {
      const c = sc, a = Math.atan2(c.site.x - start.x, c.site.z - start.z) + rnd(-0.5, 0.5), d = rnd(11, 13);
      const x = start.x + Math.sin(a) * d, z = start.z + Math.cos(a) * d;
      feats.push({ kind: 'waystone', x, z, r: 0.9 });
      cuts.push({ prim: { t: 'circle', x, z, r: 0.75 }, mat: MAT.ROCK });
      POI.push({ kind: 'waystone', x, z });
    }
    // 地标：首领场地后面的烬塔（最高），场地中部一块岩台上的断塔，另一侧岩台上的巨大枯树
    const lm = [];
    lm.push({ kind: 'landmark', type: 'spire', x: arenaC.x + rnd(-3, 3), z: arenaC.z + OPEN.arenaR + 7, h: 30 });
    const mesas = cells.filter((c) => c.kind === 'mesa');
    const mid = v2((start.x + arenaC.x) / 2, (start.z + arenaC.z) / 2);
    mesas.sort((a, b) => dist(a.site, mid) - dist(b.site, mid));
    if (mesas[0]) lm.push({ kind: 'landmark', type: 'tower', x: mesas[0].site.x, z: mesas[0].site.z, h: 17 });
    const m2 = mesas.slice(1).sort((a, b) => dist(b.site, mesas[0].site) - dist(a.site, mesas[0].site))[0];
    if (m2) lm.push({ kind: 'landmark', type: 'tree', x: m2.site.x, z: m2.site.z, h: 14 });
    for (const q of lm) feats.push(q);
    // 15. 怪群：每格按面积 1–2 群，散开；离起点 ≥ 20 m、离门 ≥ 4.5 m、离挖空 ≥ 2.6 m；营地一群大的带精英
    let elites = 0;
    for (const rm of rooms) {
      if (rm.cell === undefined) continue;
      const c = cells[rm.cell], ds = doorsOf(c.id);
      const isCamp = rm.tags.indexOf('camp') >= 0;
      // 主路线上的格子至少一群；旁边的格子按面积掷，可以空着（整张图的怪数和节奏都靠它）
      const want = isCamp ? 2 : Math.max(rm.path ? 1 : 0, Math.min(2, Math.round(c.area / OPEN.packArea + (R() - 0.5) * 0.9)));
      const mine = [];
      for (let t = 0; t < 40 && mine.length < want; t++) {
        const a = R() * TAU, d = (isCamp && !mine.length ? rnd(2, 4) : rnd(0, 0.85) * c.inR + rnd(0, 4)), x = c.site.x + Math.sin(a) * d, z = c.site.z + Math.cos(a) * d;
        if (!inPoly(c.P, x, z) || cutSd(x, z) < 2.6) continue;
        if (Math.hypot(x - start.x, z - start.z) < 22) continue;
        if (links.some((q) => Math.hypot(q.door.x - x, q.door.z - z) < 4.6)) continue;
        if (packs.concat(mine).some((p) => Math.hypot(p.x - x, p.z - z) < 10)) continue;
        if (chests.some((q) => Math.hypot(q.x - x, q.z - z) < 3)) continue;
        if (feats.some((f) => f.kind === 'bridge' && Math.hypot(f.x - x, f.z - z) < 6)) continue;
        const el = elites < 5 && (isCamp ? !mine.length : R() < (rm.path ? 0.22 : 0.12));
        if (el) elites++;
        mine.push({ room: rm.id, x, z, n: isCamp && !mine.length ? [5, 7] : [3, 5], r: isCamp ? 3 : 2.6, elite: el, ambush: false });
      }
      packs.push(...mine);
    }
    // 16. 起点 / 场地
    const r1 = rooms[sRoom].core;
    const exA = Math.atan2(r1.x - start.x, r1.z - start.z);
    const spec = {
      rooms, links, cuts, haz: [], feats, packs, chests,
      start: { x: start.x, z: start.z, exit: { x: start.x + Math.sin(exA) * OPEN.startR, z: start.z + Math.cos(exA) * OPEN.startR, ang: exA } },
      arena: {
        room: aid, x: arenaC.x, z: arenaC.z, r: OPEN.arenaR, round: true,
        door: { x: amx, z: arenaC.z - OPEN.arenaR - 2 }, dir: { x: 0, z: 1 },
        tp: { x: arenaC.x, z: arenaC.z - 7 },
      },
      path: route,
      open: {
        field: [X0, Z0, X1, Z1], cells: cells.map((c) => ({ id: c.id, P: c.P.map((p) => [p.x, p.z]), alive: c.alive, kind: c.kind, room: rid.has(c.id) ? rid.get(c.id) : -1 })),
        river: rs.map((p) => [p.x, p.z]), ridge: ridge ? ridge.pts.map((p) => [p.x, p.z]) : null, poi: POI, landmarks: lm.map((q) => ({ type: q.type, x: q.x, z: q.z, h: q.h })),
        route, gate: gid, deadEnds: rooms.filter((rm) => rm.tags.indexOf('spur') >= 0).map((rm) => rm.id),
      },
    };
    // 起点挪到 (0, 0)
    shiftSpec(spec, -start.x, -start.z);
    // 镜头朝 -z 看（画面上方 = -z），场地往 -z 方向铺开：首领在画面上方，往前走看得更远
    mirrorZ(spec);
    return { ok: true, spec };
  }
  // 格子多边形往活着的邻居那边外扩 OVL m（其余边不动）。两个 sd 取 max 在公共边上只有 round 那么大，比走路 / 寻路的 pad（0.6）还小，
  // 公共边就成了一道看不见的墙；外扩以后公共边上 sd ≈ OVL。外扩边和不动边的交点落在 Voronoi 第三格里（等距线越过顶点进的是第三格），
  // 那一格是岩台时由不动的那条边挡着，不会长进岩台
  const OVL = 4;
  function grow(c) {
    const P = c.P, n = P.length, lines = [];
    for (let k = 0; k < n; k++) {
      const a = P[k], b = P[(k + 1) % n], l = dist(a, b) || 1;
      let nx = (b.z - a.z) / l, nz = -(b.x - a.x) / l;
      if ((c.site.x - a.x) * nx + (c.site.z - a.z) * nz > 0) (nx = -nx), (nz = -nz);
      const off = c.T[k] >= 0 && c.grow && c.grow[k] ? OVL : 0;
      lines.push({ nx, nz, c: nx * a.x + nz * a.z + off, a, off });
    }
    const out = [];
    for (let k = 0; k < n; k++) {
      const A = lines[(k + n - 1) % n], B = lines[k], det = A.nx * B.nz - A.nz * B.nx;
      if (Math.abs(det) < 0.05) {
        const o = Math.max(A.off, B.off);
        out.push([P[k].x + B.nx * o, P[k].z + B.nz * o]);
        continue;
      }
      out.push([(A.c * B.nz - A.nz * B.c) / det, (A.nx * B.c - A.c * B.nx) / det]);
    }
    return out;
  }
  // z 取反：z / az / bz 取反，角度（局部 +z = (sin a, cos a)）换成 π - a，点数组 [x, z] 的 z 取反
  function mirrorZ(o) {
    const seen = new Set();
    const walk = (v, key) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        if (key === 'pts' || key === 'axis' || key === 'P' || key === 'river' || key === 'ridge') {
          for (const q of v) if (Array.isArray(q) && typeof q[0] === 'number' && !seen.has(q)) (seen.add(q), (q[1] = -q[1]));
          return;
        }
        if (key === 'field') {
          const z0 = v[1];
          v[1] = -v[3];
          v[3] = -z0;
          return;
        }
        for (const q of v) walk(q, key);
        return;
      }
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (typeof x === 'number') {
          if (k === 'z' || k === 'az' || k === 'bz') v[k] = -x;
          else if (k === 'ang') v[k] = Math.PI - x;
        } else walk(x, k);
      }
    };
    walk(o, '');
  }
  // 整份 spec 平移（x / ax / bx 这类键，pts / axis / P / field 这类数组）
  function shiftSpec(o, dx, dz) {
    const seen = new Set();
    const walk = (v, key) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        if (key === 'pts' || key === 'axis' || key === 'P' || key === 'river' || key === 'ridge') {
          for (const q of v) if (Array.isArray(q) && typeof q[0] === 'number' && !seen.has(q)) (seen.add(q), (q[0] += dx), (q[1] += dz));
          return;
        }
        if (key === 'field') {
          v[0] += dx;
          v[2] += dx;
          v[1] += dz;
          v[3] += dz;
          return;
        }
        for (const q of v) walk(q, key);
        return;
      }
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (typeof x === 'number') {
          if (k === 'x' || k === 'ax' || k === 'bx') v[k] = x + dx;
          else if (k === 'z' || k === 'az' || k === 'bz') v[k] = x + dz;
        } else walk(x, k);
      }
    };
    walk(o, '');
  }
  GEN.open = openGen;

  // ---------- 外观 ----------
  // 第 1 区原来的外观（熔岩河、石桥、枯树、残墙、焦木）照旧用 ashDress 画；这里另加：路标石、营地、地标，以及把大网格按 32 m 切块（视锥裁剪）
  const ASH = ZONE_TERRAIN.ash;
  const OCOL = { stone: 0x5e5856, stoneLo: 0x433c55, rune: 0x7fe6ff, ember: 0xff8a3c, cloth: 0x6a3a2c, clothLo: 0x3a2230, wood: 0x3a2c26 };
  const tallGeo = (type) => L.geo('open/lm/' + type, () => {
    const C = OCOL, P = [];
    if (type === 'spire') {
      // 烬塔：三段收分的黑石尖塔，裂缝透出橙光，顶上一团余烬
      P.push([L.gCyl(2.2, 3.4, 10, 7), C.stone, 0, 5, 0], [L.gCyl(1.4, 2.1, 9, 7), C.stone, 0.3, 14.5, 0, 0, 0, 0.04], [L.gCyl(0.5, 1.3, 8, 6), C.stone, 0.6, 23, 0, 0, 0, 0.06]);
      P.push([L.gBox(0.25, 7, 0.25), C.ember, 1.9, 6, 1.4], [L.gBox(0.22, 6, 0.22), C.ember, -1.2, 15, 1.3], [L.gIco(1.1, 0), C.ember, 0.9, 27.8, 0]);
      P.push([L.gCyl(4, 5, 1.2, 8), C.stoneLo, 0, 0.6, 0]);
    } else if (type === 'tower') {
      // 断塔：方石塔，一侧塌掉，顶上歪着一截
      P.push([L.gBox(4.4, 11, 4.4), C.stone, 0, 5.5, 0], [L.gBox(3.6, 4.5, 2.2), C.stone, 0, 13.2, -1.0, 0.1, 0, 0], [L.gBox(5.2, 0.6, 5.2), C.stoneLo, 0, 11.1, 0]);
      P.push([L.gBox(1.2, 1.6, 0.2), 0x1a1416, 0, 8, 2.21], [L.gBox(1.0, 1.4, 0.2), C.ember, 0, 13, 0.11]);
    } else {
      // 巨大枯树：粗干 + 张开的大枝
      P.push([L.gCyl(1.3, 2.4, 8, 8), 0x2e2826, 0, 4, 0], L.seg(0x2e2826, 0, 7, 0, 3.6, 12, 0.6, 0.8), L.seg(0x463c36, 0, 7.5, 0, -3.2, 13.5, -0.8, 0.7), L.seg(0x2e2826, 0, 8, 0, 0.4, 14.5, -2.6, 0.6));
      P.push(L.seg(0x463c36, 2.8, 11, 0.5, 5.4, 12.6, 1.2, 0.36), L.seg(0x463c36, -2.6, 12.2, -0.6, -4.6, 13.2, 0.8, 0.32));
    }
    return L.toonGradient(L.bake('open/lm0/' + type, P).clone(), { bottom: OCOL.stoneLo, top: 0xffffff, y0: 0, y1: type === 'spire' ? 20 : 10 });
  });
  const waystoneGeo = () => L.geo('open/waystone', () => L.toonGradient(L.bake('open/waystone0', [
    [L.gCyl(1.2, 1.5, 0.4, 8), OCOL.stoneLo, 0, 0.2, 0],
    [L.gCyl(0.42, 0.6, 3.2, 6), OCOL.stone, 0, 2.0, 0],
    [L.gCyl(0.15, 0.42, 0.6, 6), OCOL.stone, 0, 3.9, 0],
    [L.gBox(0.1, 1.6, 0.08), OCOL.rune, 0, 2.2, 0.5],
    [L.gBox(0.08, 1.2, 0.1), OCOL.rune, 0.5, 2.0, 0],
  ]).clone(), { bottom: OCOL.stoneLo, top: 0xffffff, y0: 0, y1: 3.5 }));
  const tentGeo = () => L.geo('open/tent', () => L.toonGradient(L.bake('open/tent0', [
    [L.gCone(1.9, 2.4, 4), OCOL.cloth, 0, 1.2, 0, 0, Math.PI / 4, 0],
    [L.gCyl(0.06, 0.06, 2.8, 4), OCOL.wood, 0, 1.4, 0],
  ]).clone(), { bottom: OCOL.clothLo, top: 0xffffff, y0: 0, y1: 2.4 }));
  const fireGeo = () => L.geo('open/fire', () => L.bake('open/fire0', [
    [L.gCyl(0.9, 1.0, 0.2, 8), 0x2a2224, 0, 0.1, 0],
    [L.gCone(0.45, 0.9, 5), 0xffb04a, 0, 0.6, 0],
    [L.gCone(0.28, 1.2, 5), 0xffe0a0, 0.1, 0.7, 0.05],
  ]));
  const stakeGeo = () => L.geo('open/stake', () => L.toonGradient(L.bake('open/stake0', [[L.gCone(0.16, 1.8, 4), OCOL.wood, 0, 0.9, 0]]).clone(), { bottom: OCOL.clothLo, top: 0xffffff, y0: 0, y1: 1.8 }));

  function openDress(zone, ctx) {
    const out = ASH.dress(zone, ctx) || {};
    const feats = zone.feats || [], rnd = mulberry32((zone.vseed ^ 0x6f70656e) >>> 0), r = (a, b) => a + (b - a) * rnd();
    const parts = [], glow = [];
    for (const f of feats) {
      if (f.kind === 'landmark') parts.push([tallGeo(f.type), f.x, 0, f.z, 0, r(0, TAU), 0, 1, 1, 1, 1]);
      else if (f.kind === 'waystone') {
        parts.push([waystoneGeo(), f.x, 0, f.z, 0, r(0, TAU), 0, 1, 1, 1, 1]);
      } else if (f.kind === 'camp') {
        // 营地：火堆 + 2–3 顶帐篷 + 一圈木桩
        glow.push([fireGeo(), f.x, 0, f.z, 0, 0, 0, 1, 1, 1, 1]);
        const nt = 2 + Math.floor(rnd() * 2), a0 = r(0, TAU);
        for (let i = 0; i < nt; i++) {
          const a = a0 + (i / nt) * TAU + r(-0.3, 0.3), d = r(4.2, 5.4), x = f.x + Math.sin(a) * d, z = f.z + Math.cos(a) * d;
          if (W.sdAt(x, z) < 1.6) continue;
          parts.push([tentGeo(), x, 0, z, 0, r(0, TAU), 0, r(0.9, 1.1), r(0.9, 1.1), r(0.9, 1.1), 1]);
        }
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * TAU + r(-0.1, 0.1), d = r(7.5, 8.5), x = f.x + Math.sin(a) * d, z = f.z + Math.cos(a) * d;
          if (W.sdAt(x, z) < 0.6 || rnd() < 0.35) continue;
          parts.push([stakeGeo(), x, 0, z, r(-0.25, 0.25), r(0, TAU), r(-0.25, 0.25), 1, r(0.8, 1.2), 1, 1]);
        }
      }
    }
    if (parts.length) {
      const m = new T.Mesh(L.ashMerge(parts), ctx.own(ctx.makeToonMat({ brush: 0.12, brushScale: 0.6, soft: 0.1 })));
      m.castShadow = m.receiveShadow = true;
      m.name = 'openProps';
      ctx.group.add(m);
      out.openProps = m;
    }
    if (glow.length) {
      const m = new T.Mesh(L.ashMerge(glow), ctx.own(new T.MeshBasicMaterial({ vertexColors: true, fog: true })));
      m.name = 'openGlow';
      ctx.group.add(m);
      out.openGlow = m;
    }
    if (OPEN.chunk !== false) out.chunks = chunkify(ctx.group);
    return out;
  }
  // ---------- 切块：大网格按 32 m 的格子分成几块，各自算包围球，镜头外的块不画 ----------
  // 静态网格（非实例化，> 6000 个三角形、外接框 > 60 m）：按三角形重心分到格子里，每块一个新的 index（共用顶点数据）。
  // 实例化网格（> 64 个实例、frustumCulled = false 的那些）：按实例位置分到格子里，每块一个 InstancedMesh。
  function chunkify(group) {
    const CH = OPEN.chunkM || 40, stats = { meshes: 0, chunks: 0, inst: 0, ichunks: 0 };
    const kids = group.children.slice();
    for (const m of kids) {
      if (m.userData.noChunk) continue;
      if (m.isInstancedMesh) {
        if (m.count < 64 || m.frustumCulled) continue;
        const g = m.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const gr = g.boundingSphere.radius, buckets = new Map(), mt = new T.Matrix4(), p = new T.Vector3(), col = new T.Color();
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, mt);
          p.setFromMatrixPosition(mt);
          const k = Math.floor(p.x / CH) + ',' + Math.floor(p.z / CH);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(i);
        }
        if (buckets.size < 3) continue;
        for (const list of buckets.values()) {
          const im = new T.InstancedMesh(g, m.material, list.length);
          const box = new T.Box3();
          let sMax = 1;
          list.forEach((i, j) => {
            m.getMatrixAt(i, mt);
            im.setMatrixAt(j, mt);
            if (m.instanceColor) {
              m.getColorAt(i, col);
              im.setColorAt(j, col);
            }
            p.setFromMatrixPosition(mt);
            box.expandByPoint(p);
            sMax = Math.max(sMax, mt.getMaxScaleOnAxis());
          });
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          // 包围球：按实例位置的外接框 + 几何体半径 × 最大缩放（three 按 geometry.boundingSphere 裁剪 InstancedMesh：r186 用 im.boundingSphere）
          const sph = new T.Sphere();
          box.getBoundingSphere(sph);
          sph.radius += gr * sMax;
          im.boundingSphere = sph;
          im.frustumCulled = true;
          im.castShadow = m.castShadow;
          im.receiveShadow = m.receiveShadow;
          im.renderOrder = m.renderOrder;
          im.name = (m.name || 'inst') + '#';
          im.onBeforeRender = m.onBeforeRender;
          im.layers.mask = m.layers.mask;
          im.visible = m.visible;
          group.add(im);
          stats.ichunks++;
        }
        m.visible = false;
        m.userData.chunked = true;
        stats.inst++;
        continue;
      }
      if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) continue;
      const g = m.geometry, pos = g.attributes.position, idx = g.index;
      const nTri = idx ? idx.count / 3 : pos.count / 3;
      if (nTri < 6000) continue;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (bb.max.x - bb.min.x < 60 && bb.max.z - bb.min.z < 60) continue;
      if (m.matrixWorldNeedsUpdate || m.position.lengthSq() > 1e-6 || m.rotation.y !== 0 || m.scale.x !== 1) continue; // 只切没有变换的网格（世界坐标 = 顶点坐标）
      const buckets = new Map(), vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
      for (let t = 0; t < nTri; t++) {
        const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        const k = Math.floor(cx / CH) + ',' + Math.floor(cz / CH);
        if (!buckets.has(k)) buckets.set(k, []);
        const L2 = buckets.get(k);
        L2.push(a, b, c);
      }
      if (buckets.size < 3) continue;
      for (const list of buckets.values()) {
        const ng = new T.BufferGeometry();
        for (const name of Object.keys(g.attributes)) ng.setAttribute(name, g.attributes[name]);
        const I = pos.count > 65535 ? new Uint32Array(list) : new Uint16Array(list);
        ng.setIndex(new T.BufferAttribute(I, 1));
        const box = new T.Box3(), p = new T.Vector3();
        for (const v of list) box.expandByPoint(p.fromBufferAttribute(pos, v));
        ng.boundingBox = box;
        ng.boundingSphere = box.getBoundingSphere(new T.Sphere());
        const cm = new T.Mesh(ng, m.material);
        cm.castShadow = m.castShadow;
        cm.receiveShadow = m.receiveShadow;
        cm.renderOrder = m.renderOrder;
        cm.name = (m.name || 'mesh') + '#';
        cm.onBeforeRender = m.onBeforeRender;
        cm.layers.mask = m.layers.mask;
        cm.visible = m.visible;
        cm.userData.chunkOf = m.name || '';
        group.add(cm);
        stats.chunks++;
      }
      m.visible = false;
      m.userData.chunked = true;
      stats.meshes++;
    }
    return stats;
  }
  function openFx(dt, D, ctx) {
    if (ASH.fx) ASH.fx(dt, D, ctx);
    revealTick();
  }
  ZONE_TERRAIN.ash = { gen: openGen, dress: openDress, fx: openFx, tick: ASH.tick };
  W.openOrigAsh = ASH;

  // ---------- 小地图迷雾：走过的地方才显示（4 m 一格，半径 26 m），地标一直显示（框外的画在边上当指向） ----------
  const FOG = { cell: 4, r: 26, grid: null, base: null, nx: 0, nz: 0, x0: 0, z0: 0, dirty: false, t: 0, seen: 0, total: 0, zone: null };
  W.openFog = FOG;
  function fogReset(zone) {
    const b = zone.bounds;
    FOG.zone = zone;
    FOG.x0 = b.minX;
    FOG.z0 = b.minZ;
    FOG.nx = Math.ceil((b.maxX - b.minX) / FOG.cell) + 1;
    FOG.nz = Math.ceil((b.maxZ - b.minZ) / FOG.cell) + 1;
    FOG.grid = new Uint8Array(FOG.nx * FOG.nz);
    FOG.total = 0;
    for (let j = 0; j < FOG.nz; j++) for (let i = 0; i < FOG.nx; i++) if (W.walkable(FOG.x0 + (i + 0.5) * FOG.cell, FOG.z0 + (j + 0.5) * FOG.cell, 0)) FOG.total++;
    FOG.seen = 0;
  }
  function revealAt(x, z) {
    const g = FOG.grid;
    if (!g) return;
    const c = FOG.cell, R2 = FOG.r * FOG.r;
    const i0 = Math.max(0, Math.floor((x - FOG.r - FOG.x0) / c)), i1 = Math.min(FOG.nx - 1, Math.floor((x + FOG.r - FOG.x0) / c));
    const j0 = Math.max(0, Math.floor((z - FOG.r - FOG.z0) / c)), j1 = Math.min(FOG.nz - 1, Math.floor((z + FOG.r - FOG.z0) / c));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * FOG.nx + i;
        if (g[k]) continue;
        const cx = FOG.x0 + (i + 0.5) * c, cz = FOG.z0 + (j + 0.5) * c;
        if ((cx - x) * (cx - x) + (cz - z) * (cz - z) > R2) continue;
        g[k] = 1;
        if (W.walkable(cx, cz, 0)) FOG.seen++;
        FOG.dirty = true;
      }
    }
  }
  function revealTick() {
    const z = W.zone;
    if (!z || !z.spec || !z.spec.open) return;
    if (FOG.zone !== z) {
      fogReset(z);
      FOG.dirty = true;
    }
    const P = G.player;
    if (P) revealAt(P.x, P.z);
    FOG.t += 1;
    if (FOG.dirty && FOG.t % 6 === 0) fogPaint();
  }
  W.openReveal = (x, z) => (revealAt(x, z), fogPaint());
  W.openRevealAll = () => {
    if (FOG.grid) FOG.grid.fill(1);
    FOG.seen = FOG.total;
    fogPaint();
  };
  // 底图画好时存一份；迷雾变了就把「底图 + 迷雾」重画进 MM.cv
  W.mmBuilt = function (zone, cv) {
    if (!zone.spec || !zone.spec.open) {
      FOG.base = null;
      return;
    }
    const b = document.createElement('canvas');
    b.width = cv.width;
    b.height = cv.height;
    b.getContext('2d').drawImage(cv, 0, 0);
    FOG.base = b;
    if (FOG.zone !== zone) fogReset(zone);
    if (P0()) revealAt(G.player.x, G.player.z);
    fogPaint();
  };
  const P0 = () => G.player && W.zone && G.state && G.state.zone === W.zone;
  let fogCv = null;
  function fogPaint() {
    FOG.dirty = false;
    const MM = L.MM, cv = MM.cv, z = W.zone;
    if (!FOG.base || !cv || !z || !FOG.grid || FOG.base.width !== cv.width) return;
    if (!fogCv || fogCv.width !== FOG.nx || fogCv.height !== FOG.nz) {
      fogCv = document.createElement('canvas');
      fogCv.width = FOG.nx;
      fogCv.height = FOG.nz;
    }
    const fg = fogCv.getContext('2d'), im = fg.createImageData(FOG.nx, FOG.nz), D = im.data;
    for (let k = 0; k < FOG.grid.length; k++) {
      D[k * 4] = 12;
      D[k * 4 + 1] = 9;
      D[k * 4 + 2] = 8;
      D[k * 4 + 3] = FOG.grid[k] ? 0 : 236;
    }
    fg.putImageData(im, 0, 0);
    const g = cv.getContext('2d'), dpr = cv.width / MM.cw;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(FOG.base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(fogCv, FOG.x0 * MM.s + MM.ox, FOG.z0 * MM.s + MM.oz, FOG.nx * FOG.cell * MM.s, FOG.nz * FOG.cell * MM.s);
    g.setTransform(1, 0, 0, 1, 0, 0);
    MM.vDirty = true;
  }
  const LM_CSS = { spire: '#ff8a3c', tower: '#d8c8b0', tree: '#c8b08a' };
  W.mmOverlay = function (g, X, Z, inMM, mx, my, S) {
    const z = W.zone;
    if (!z || !z.spec || !z.spec.open) return;
    const o = z.spec.open;
    // 路标石：青色小菱形
    for (const p of o.poi) {
      if (p.kind !== 'waystone') continue;
      const x = X(p.x), y = Z(p.z);
      if (!inMM(x, y)) continue;
      g.fillStyle = '#7fe6ff';
      g.beginPath();
      g.moveTo(x, y - 3.5);
      g.lineTo(x + 3, y);
      g.lineTo(x, y + 3.5);
      g.lineTo(x - 3, y);
      g.closePath();
      g.fill();
    }
    // 营地（揭开以后）：橙色小三角
    for (const p of o.poi) {
      if (p.kind !== 'camp' || !fogSeen(p.x, p.z)) continue;
      const x = X(p.x), y = Z(p.z);
      if (!inMM(x, y)) continue;
      g.fillStyle = '#ff9a3c';
      g.beginPath();
      g.moveTo(x, y - 3.5);
      g.lineTo(x + 3.5, y + 3);
      g.lineTo(x - 3.5, y + 3);
      g.closePath();
      g.fill();
    }
    // 地标：一直显示；框外的贴在框边上，指向它
    const cx = mx + S / 2, cy = my + S / 2;
    for (const q of o.landmarks) {
      let x = X(q.x), y = Z(q.z);
      const inside = inMM(x, y);
      if (!inside) {
        const dx = x - cx, dy = y - cy, k = (S / 2 - 6) / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
        x = cx + dx * k;
        y = cy + dy * k;
      }
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.lineWidth = 2;
      g.fillStyle = LM_CSS[q.type] || '#fff';
      g.beginPath();
      if (q.type === 'spire') {
        g.moveTo(x, y - 5);
        g.lineTo(x + 3, y + 4);
        g.lineTo(x - 3, y + 4);
      } else {
        g.rect(x - 2.5, y - 4, 5, 8);
      }
      g.closePath();
      g.stroke();
      g.fill();
    }
  };
  function fogSeen(x, z) {
    if (!FOG.grid) return true;
    const i = Math.floor((x - FOG.x0) / FOG.cell), j = Math.floor((z - FOG.z0) / FOG.cell);
    return i >= 0 && j >= 0 && i < FOG.nx && j < FOG.nz && !!FOG.grid[j * FOG.nx + i];
  }

  // ---------- 异兆：开放式地图大，进区掷 3 个（层级 ≥ 1 掷 4 个），点位照旧由 W.encSite 挑 ----------
  const rollEnc0 = G.rollEncounters;
  if (rollEnc0) {
    G.rollEncounters = function (zone, tier, force) {
      if (force || !zone || !zone.spec || !zone.spec.open || (G.debug && G.debug.noEnc)) return rollEnc0.call(this, zone, tier, force);
      const wi = (tier | 0) >= 1 ? 1 : 0, pool = G.ENC_IDS.filter((id) => G.ENCOUNTERS[id].w[wi] > 0), list = [];
      for (let n = wi ? 4 : 3; n > 0 && pool.length; n--) {
        const id = G.weighted(pool, (k) => G.ENCOUNTERS[k].w[wi]);
        pool.splice(pool.indexOf(id), 1);
        list.push(id);
      }
      return rollEnc0.call(this, zone, tier, list);
    };
  }

  // ---------- 调试 / 截图：整张图的俯视示意（可走地面、障碍、主路线、兴趣点、地标视线） ----------
  W.openInfo = function () {
    const z = W.zone;
    if (!z || !z.spec || !z.spec.open) return null;
    const o = z.spec.open, rooms = z.rooms;
    let area = 0;
    const m = z.map;
    for (let j = 0; j < m.mz; j++) for (let i = 0; i < m.mx; i++) if (W.walkable(m.x0 + i * m.h2, m.z0 + j * m.h2, 0)) area += m.h2 * m.h2;
    // 主路线长度：起点 → 各门 → 场地中心
    const routePts = routeLine(z);
    let routeLen = 0;
    for (let i = 1; i < routePts.length; i++) routeLen += Math.hypot(routePts[i][0] - routePts[i - 1][0], routePts[i][1] - routePts[i - 1][1]);
    const deg = rooms.map(() => 0);
    for (const lk of z.links) (deg[lk.a]++), (deg[lk.b]++);
    return {
      seed: z.seed, rooms: rooms.length, cells: rooms.filter((r) => r.kind === 'room' || r.kind === 'side').length, mainRoute: o.route.length,
      links: z.links.length, area: Math.round(area), packs: z.packs.length, elites: z.packs.filter((p) => p.elite).length, chests: z.chests.length,
      deadEnds: rooms.filter((r) => (r.kind === 'side' || r.kind === 'room') && deg[r.id] <= 1).length, routeLen: Math.round(routeLen),
      bounds: z.bounds, landmarks: o.landmarks, poi: o.poi, enc: (G.state.enc || []).map((e) => ({ kind: e.kind, x: e.site.x, z: e.site.z })),
      grid: { nx: m.nx, nz: m.nz, h: m.h, ms: Math.round(m.ms) },
      fog: { seen: FOG.seen, total: FOG.total },
    };
  };
  function routeLine(z) {
    const o = z.spec.open, pts = [[z.start.x, z.start.z]];
    for (let i = 0; i + 1 < o.route.length; i++) {
      const a = o.route[i], b = o.route[i + 1], lk = z.links.find((q) => (q.a === a && q.b === b) || (q.a === b && q.b === a));
      if (lk && lk.door) pts.push([lk.door.x, lk.door.z]);
      if (i + 1 < o.route.length - 1) pts.push([z.rooms[b].core.x, z.rooms[b].core.z]);
    }
    pts.push([z.arena.x, z.arena.z]);
    return pts;
  }
  W.openRouteLine = () => (W.zone ? routeLine(W.zone) : null);
  // 俯视示意图（canvas dataURL）。px：每米多少像素
  W.openOverview = function (o) {
    o = o || {};
    const z = W.zone, sp = z.spec, op = sp.open, b = z.bounds, px = o.px || 4, pad = 30;
    const w = Math.ceil((b.maxX - b.minX) * px) + pad * 2, h = Math.ceil((b.maxZ - b.minZ) * px) + pad * 2 + 70;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    // 和小地图、镜头一样：-z 在上
    const X = (x) => pad + (x - b.minX) * px, Y = (zz) => pad + (zz - b.minZ) * px;
    const im = g.createImageData(w, h), D = im.data, m = z.map;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const wx = b.minX + (i - pad) / px, wz = b.minZ + (j - pad) / px, q = (j * w + i) * 4;
        const d = L.gridAt(m, m.sd, wx, wz);
        let c = [22, 17, 16];
        if (d >= 0) {
          const rm = W.roomAt(wx, wz), rr = z.rooms[rm];
          c = rr && rr.path ? [122, 102, 88] : [104, 88, 78];
          if (rr && rr.kind === 'arena') c = [130, 84, 70];
          if (rr && rr.kind === 'start') c = [110, 120, 128];
        } else {
          const mt = L.matAt(m, wx, wz);
          if (mt === MAT.LAVA) c = [214, 92, 40];
          else if (mt === MAT.WALL) c = [70, 64, 70];
          else if (d > -1.2) c = [52, 42, 40];
          else c = [34, 28, 28];
        }
        D[q] = c[0];
        D[q + 1] = c[1];
        D[q + 2] = c[2];
        D[q + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    // 格子边（细线，调试）
    if (o.cells !== false) {
      g.strokeStyle = 'rgba(255,240,220,0.10)';
      g.lineWidth = 1;
      for (const c of op.cells) {
        if (!c.alive) continue;
        g.beginPath();
        c.P.forEach((p, k) => (k ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
        g.closePath();
        g.stroke();
      }
    }
    // 房间图的连接（门）：细的浅色线
    g.strokeStyle = 'rgba(255,230,190,0.28)';
    g.lineWidth = 1.2;
    for (const lk of z.links) {
      const A = z.rooms[lk.a].core, B = z.rooms[lk.b].core, d = lk.door;
      g.beginPath();
      g.moveTo(X(A.x), Y(A.z));
      g.lineTo(X(d.x), Y(d.z));
      g.lineTo(X(B.x), Y(B.z));
      g.stroke();
    }
    // 其它路线（备选）：把主路线经过的格子罚分后再找两条
    const alts = altRoutes(z, 2);
    const altCol = ['rgba(120,200,255,0.85)', 'rgba(170,255,150,0.85)'];
    alts.forEach((pts, k) => {
      g.strokeStyle = altCol[k];
      g.lineWidth = 3;
      g.setLineDash([10, 7]);
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      g.stroke();
    });
    g.setLineDash([]);
    // 主路线
    g.strokeStyle = '#ffd36a';
    g.lineWidth = 4;
    g.beginPath();
    routeLine(z).forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
    g.stroke();
    // 地标视线：起点 → 各地标（虚线），终点画塔形
    for (const q of op.landmarks) {
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1.5;
      g.setLineDash([3, 6]);
      g.beginPath();
      g.moveTo(X(z.start.x), Y(z.start.z));
      g.lineTo(X(q.x), Y(q.z));
      g.stroke();
      g.setLineDash([]);
    }
    // 怪群
    for (const p of z.packs) {
      g.fillStyle = p.elite ? '#ffc04a' : '#ff5a48';
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(X(p.x), Y(p.z), p.elite ? 6 : 4.5, 0, TAU);
      g.fill();
      g.stroke();
    }
    // 宝箱
    for (const c of z.chests) {
      g.fillStyle = '#ffe07a';
      g.strokeStyle = '#000';
      g.fillRect(X(c.x) - 5, Y(c.z) - 4, 10, 8);
      g.strokeRect(X(c.x) - 5, Y(c.z) - 4, 10, 8);
    }
    // 异兆
    for (const e of G.state.enc || []) {
      g.strokeStyle = '#b48cff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(X(e.site.x), Y(e.site.z), 9, 0, TAU);
      g.stroke();
    }
    // 兴趣点
    const label = (x, y, s, col) => {
      g.font = 'bold 15px sans-serif';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.strokeText(s, x, y);
      g.fillStyle = col;
      g.fillText(s, x, y);
    };
    for (const p of op.poi) {
      if (p.kind === 'camp') {
        g.fillStyle = '#ff9a3c';
        g.beginPath();
        g.moveTo(X(p.x), Y(p.z) - 11);
        g.lineTo(X(p.x) + 10, Y(p.z) + 8);
        g.lineTo(X(p.x) - 10, Y(p.z) + 8);
        g.closePath();
        g.fill();
        label(X(p.x) + 12, Y(p.z) + 5, 'camp', '#ffb070');
      } else if (p.kind === 'waystone') {
        g.fillStyle = '#7fe6ff';
        g.beginPath();
        g.arc(X(p.x), Y(p.z), 7, 0, TAU);
        g.fill();
        label(X(p.x) + 10, Y(p.z) + 5, 'waystone', '#9ff0ff');
      }
    }
    for (const q of op.landmarks) {
      g.fillStyle = LM_CSS[q.type];
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(q.x), Y(q.z) - 14);
      g.lineTo(X(q.x) + 8, Y(q.z) + 8);
      g.lineTo(X(q.x) - 8, Y(q.z) + 8);
      g.closePath();
      g.fill();
      g.stroke();
      label(X(q.x) + 11, Y(q.z) - 2, q.type + ' ' + q.h + 'm · ' + Math.round(Math.hypot(q.x - z.start.x, q.z - z.start.z)) + 'm', '#fff');
    }
    label(X(z.start.x) + 12, Y(z.start.z) + 5, 'START', '#cfe8ff');
    label(X(z.arena.x) + 18, Y(z.arena.z), 'BOSS', '#ff8a7a');
    // 比例尺 + 图例
    const ly = h - 50;
    g.fillStyle = '#fff';
    g.fillRect(pad, ly, 20 * px, 4);
    label(pad, ly - 6, '20 m', '#fff');
    const inf = W.openInfo();
    label(pad + 20 * px + 20, ly + 6, 'seed ' + z.seed + ' · area ' + inf.area + ' m² · route ' + inf.routeLen + ' m · packs ' + inf.packs + ' (elite ' + inf.elites + ') · chests ' + inf.chests + ' · dead ends ' + inf.deadEnds, '#fff');
    label(pad, ly + 34, 'gold = main route   blue / green dashed = alternative routes   white dotted = sightline start → landmark   red = pack, gold dot = elite pack, purple ring = encounter', '#ddd');
    return cv.toDataURL('image/png');
  };
  // 备选路线：主路线经过的格子边权 × 4 后再找最短路，重复 k 次（每次再罚上一条）
  function altRoutes(z, k) {
    const rooms = z.rooms, n = rooms.length, pen = new Float64Array(n).fill(1), out = [];
    const route0 = z.spec.open.route;
    for (const r of route0) if (rooms[r].kind === 'room') pen[r] = 4;
    for (let t = 0; t < k; t++) {
      const adj = rooms.map(() => []);
      for (const lk of z.links) {
        const A = rooms[lk.a].core, B = rooms[lk.b].core, d = lk.door;
        const w = Math.hypot(A.x - d.x, A.z - d.z) * pen[lk.a] + Math.hypot(B.x - d.x, B.z - d.z) * pen[lk.b];
        adj[lk.a].push([lk.b, w, lk]);
        adj[lk.b].push([lk.a, w, lk]);
      }
      const D = new Float64Array(n).fill(Infinity), P = new Int32Array(n).fill(-1), PL = new Array(n), done = new Uint8Array(n);
      D[0] = 0;
      for (;;) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!done[i] && D[i] < Infinity && (u < 0 || D[i] < D[u])) u = i;
        if (u < 0) break;
        done[u] = 1;
        for (const [v, w, lk] of adj[u]) if (D[u] + w < D[v]) (D[v] = D[u] + w), (P[v] = u), (PL[v] = lk);
      }
      const A = z.arena.room;
      if (!(D[A] < Infinity)) break;
      const ids = [];
      for (let q = A; q >= 0; q = P[q]) ids.push(q);
      ids.reverse();
      const pts = [[z.start.x, z.start.z]];
      for (let i = 1; i < ids.length; i++) {
        const lk = PL[ids[i]];
        pts.push([lk.door.x, lk.door.z]);
        if (i < ids.length - 1) pts.push([rooms[ids[i]].core.x, rooms[ids[i]].core.z]);
        if (rooms[ids[i]].kind === 'room' || rooms[ids[i]].kind === 'side') pen[ids[i]] *= 3;
      }
      pts.push([z.arena.x, z.arena.z]);
      out.push(pts);
    }
    return out;
  }
  W.openAlt = (k) => (W.zone ? altRoutes(W.zone, k || 2) : null);
})();
