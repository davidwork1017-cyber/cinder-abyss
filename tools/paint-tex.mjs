// 脚本画的地面 / 岩石平铺贴图的像素（只用 Node，不要浏览器）。tools/gen-paint-textures.mjs 拿它编码成 JPEG（钉住 Chrome 版本），
// tools/check-textures.mjs 经 tools/ground-tex.mjs 的 JOBS 重新算像素、核对 assets/generated/manifest.json 里的 sha256（同样的代码 → 同样的像素）。
//   p_mud    第 0 区路面（顶替 mud_cracked_dry_03）：烧干龟裂的焦土。裂纹分三级而且不均匀：大部分是几块大板，
//            一簇簇的地方才碎成中块 / 小块，另有成片不裂的平地；裂缝粗细沿线变化、两头收尖、中间会断开，读起来是裂开的地，不是一张网。
//   p_burn   第 0 区粗糙地面（顶替 burned_ground_01）：低频的成片焦痕（三档色调，边缘软）+ 零星的大颗碎石 + 拖长的焦黑。
//   p_rock   第 0 区虚空地面和岩壁 / 布景的三向投影（第 0 区不再用照片 dark_rock）：大面为主、一部分大面再分成小面，暗缝断断续续。
//   p_ice    第 1 区路面（tex-t3，顶替 Ice002）：大块冰板、几道断续的压裂缝、冰下成片的深浅和霜斑。
//   p_snow   第 1 区粗糙地面（tex-t3，顶替 Snow013）：风吹成条的积雪，雪薄处露出冻土和零星碎石。
//   p_frock  第 1 区虚空地面和水边岩石的三向投影（tex-t3，顶替这一区用的 Rock035）：棱面 + 断续的横向岩层。
//   p_slab   第 2 区路面（tex-rest，顶替 monastery_stone_floor）：错缝铺的切石板，有的再分小块、崩角、裂开，缝里积着砂砾。
//   p_grit   第 2 区粗糙地面（tex-rest，顶替 rocky_trail）：成片的细砂和碎石、零星崩下来的碎石板、很淡的水渍。
//   p_srock  第 2 区虚空地面和岩石 / 布景的三向投影（tex-rest，顶替这一区用的 Rock035）：切比雪夫胞的方正岩块 + 横向岩层。
// 每张 512² 的 albedo / normal / arh（R 遮蔽 G 粗糙度 B 高度，和 prep-textures.mjs 的格式一样），低档用的 256² lo（albedo / arh，2×2 盒式缩小；
// 低档不传法线贴图，游戏里用平的法线）。
const N = 512;

// ---------- 噪声（可平铺：坐标按周期 P 取模） ----------
function hashI(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((s | 0) + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const md = (v, P) => ((v % P) + P) % P;
const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const sstep = (a, b, x) => sm((x - a) / (b - a));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function vn(u, v, P, s) {
  const x = u * P, y = v * P, ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hashI(md(ix, P), md(iy, P), s), b = hashI(md(ix + 1, P), md(iy, P), s), c = hashI(md(ix, P), md(iy + 1, P), s), d = hashI(md(ix + 1, P), md(iy + 1, P), s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(u, v, P, oct, s) {
  let a = 0.5, f = 1, t = 0, n = 0;
  for (let o = 0; o < oct; o++) {
    t += a * vn(u, v, P * f, s + o * 31);
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return t / n;
}
// Worley：F1、F2（格子单位）、最近点 id、最近点相对坐标（算面内渐变）
function worley(u, v, P, s, jit = 0.85) {
  const x = u * P, y = v * P, ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0, cx0 = 0, cy0 = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = md(ix + i, P), cy = md(iy + j, P);
      const px = ix + i + 0.5 + (hashI(cx, cy, s) - 0.5) * jit, py = iy + j + 0.5 + (hashI(cx, cy, s + 7) - 0.5) * jit;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hashI(cx, cy, s + 13);
        cx0 = px - x;
        cy0 = py - y;
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id, cx0, cy0];
}
// 域扭曲：裂缝不是直线
function warp(u, v, P, k, s) {
  return [u + (fbm(u, v, P, 2, s) - 0.5) * k, v + (fbm(u, v, P, 2, s + 59) - 0.5) * k];
}
// 软分档：x 落到 n 档上，档与档之间留 w 宽的平滑过渡（平涂的色块，不是硬色阶）
function poster(x, n, w) {
  const y = x * n, i = Math.floor(y), f = y - i;
  return (i + sstep(0.5 - w, 0.5 + w, f)) / n;
}
// 一条裂缝的「墨线」：d = 到缝中线的距离（512² 的像素），w = 这一点的半宽（像素，沿线变化，0 = 断开）。
// 半宽小于 1 像素时线变淡而不是变成均匀的细线，所以缝的两头是收尖的
const line = (d, w) => clamp01(w - d + 0.5) * sm(clamp01(w / 1.1));
// Worley 胞缝到中线的距离（像素）：e = F2 − F1 是格子单位，离中垂线的距离约 e / 2
const edgePx = (e, P) => (e / (2 * P)) * N;

// tex-rest：周期为 1 的坐标差（四方连续的板 / 胞里算到中心的距离）
const wrapD = (d) => d - Math.round(d);
// 切比雪夫距离的 Worley（max(|dx|, |dy|)，胞是方的、有棱角）；ax = 横向拉长的倍数（整数周期 P 横向变成 P / ax 个胞，要能整除）
function chebCell(u, v, P, s, ax = 1) {
  const Px = Math.max(1, Math.round(P / ax)), x = u * Px, y = v * P, ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0, cx0 = 0, cy0 = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = md(ix + i, Px), cy = md(iy + j, P);
      const px = ix + i + 0.5 + (hashI(cx, cy, s) - 0.5) * 0.8, py = iy + j + 0.5 + (hashI(cx, cy, s + 7) - 0.5) * 0.8;
      const d = Math.max(Math.abs(px - x) * (P / Px), Math.abs(py - y));
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hashI(cx, cy, s + 13);
        cx0 = (px - x) / Px;
        cy0 = (py - y) / P;
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id, cx0 * P, cy0 * P];
}
// 错缝铺的长方石板（四方连续）：R 行，行高不一；每行 3–6 块，板长不一、每行错开。
// 返回这一点所在的板：key（行 × 8 + 块）、id（0..1）、板的范围（x 可能跨过 0/1 的接缝）、中心、到最近板缝的距离 dE（像素）
const SLAB_R = 6;
function slabAt(u, v, S) {
  const vv = md(v, 1), uu = md(u, 1);
  const hs = [];
  let tot = 0;
  for (let r = 0; r < SLAB_R; r++) {
    const h = 0.6 + 0.8 * hashI(r, 3, S + 100);
    hs.push(h);
    tot += h;
  }
  let y0 = 0, r = 0;
  for (; r < SLAB_R - 1; r++) {
    if (vv < y0 + hs[r] / tot) break;
    y0 += hs[r] / tot;
  }
  let y1 = r === SLAB_R - 1 ? 1 : y0 + hs[r] / tot;
  const n = 3 + Math.floor(hashI(r, 5, S + 101) * 3), off = hashI(r, 7, S + 102);
  const xu = md(uu - off, 1);
  let j = 0, x0 = 0, x1 = 1;
  const cut = (k) => (k <= 0 ? 0 : k >= n ? 1 : (k + 0.36 * (hashI(r * 16 + k, 9, S + 103) - 0.5)) / n);
  for (j = 0; j < n; j++) {
    x0 = cut(j);
    x1 = cut(j + 1);
    if (xu < x1) break;
  }
  if (j >= n) j = n - 1;
  let key = r * 8 + j;
  // 约三成的板再分开：横着切成上下两块，或者切成田字的四小块（打破一行一行的节奏）
  const sp = hashI(key, 61, S + 105);
  if (sp < 0.3) {
    const ym = y0 + (y1 - y0) * (0.4 + 0.2 * hashI(key, 63, S + 106));
    const top = vv >= ym;
    if (top) y0 = ym;
    else y1 = ym;
    key = key * 4 + (top ? 1 : 2);
    if (sp < 0.12) {
      const xm = x0 + (x1 - x0) * (0.4 + 0.2 * hashI(key, 65, S + 107));
      if (xu >= xm) {
        x0 = xm;
        key += 1000;
      } else x1 = xm;
    }
    key += 4096;
  }
  const dE = Math.min(xu - x0, x1 - xu, vv - y0, y1 - vv) * N;
  return { key, id: hashI(key, 11, S + 104), x0: x0 + off, x1: x1 + off, y0, y1, cx: (x0 + x1) / 2 + off, cy: (y0 + y1) / 2, dE };
}

// ---------- 三张贴图：fn(u, v) → { c: [r,g,b]（0..1 显示值）, h, ao, rough } ----------
const TEX = {
  // 龟裂焦土（种子 211）
  p_mud: {
    seed: 211,
    nrm: 1.1,
    fn(u0, v0, S) {
      // 分区：clM = 碎成中块的簇（约三成面积），clS = 簇里再碎成小块的核（约一成），calm = 不裂的平地（约两成，大裂缝也在这里断掉）
      const clM = sstep(0.47, 0.6, fbm(u0, v0, 4, 3, S + 1));
      const clS = clM * sstep(0.58, 0.68, fbm(u0, v0, 6, 2, S + 2));
      const calm = sstep(0.54, 0.66, fbm(u0, v0, 2, 3, S + 3)) * (1 - clM);
      // 大板：3 个胞一个周期（6.5 m 的平铺 → 约 2 m 一块），低频扭曲 + 一点高频抖动（缝是弯的、毛的）
      let [u, v] = warp(u0, v0, 3, 0.14, S + 4);
      [u, v] = warp(u, v, 14, 0.012, S + 5);
      const A = worley(u, v, 3, S + 6, 0.9);
      const wA = 2.0 * sstep(0.28, 0.62, fbm(u0, v0, 9, 2, S + 7)) * (1 - calm) * (0.75 + 0.5 * fbm(u0, v0, 24, 1, S + 8));
      const cA = line(edgePx(A[1] - A[0], 3), wA);
      // 中块：7 个胞一个周期，只在簇里
      let [u2, v2] = warp(u0, v0, 6, 0.06, S + 9);
      [u2, v2] = warp(u2, v2, 20, 0.006, S + 10);
      const B = worley(u2, v2, 7, S + 11, 0.9);
      const wB = 1.35 * clM * sstep(0.3, 0.5, fbm(u0, v0, 6, 2, S + 12)) * (0.7 + 0.6 * fbm(u0, v0, 20, 1, S + 18));
      const cB = line(edgePx(B[1] - B[0], 7), wB);
      // 小块：13 个胞一个周期，只在小核里，最细；整片一起出现（不按边断开，免得碎成一个个星形的刺）
      const [u3, v3] = warp(u0, v0, 12, 0.03, S + 13);
      const Cc = worley(u3, v3, 13, S + 14, 0.9);
      const wC = 0.8 * clS;
      const cC = line(edgePx(Cc[1] - Cc[0], 13), wC);
      const crack = Math.max(cA, cB * 0.9, cC * 0.75);
      // 大缝边上软的一圈压暗（像积着灰的凹处），只沿着粗的那几道
      const near = (1 - sstep(0, 7, edgePx(A[1] - A[0], 3))) * sm(clamp01(wA / 1.5)) * 0.5;
      // 板面：色调差很小（每块 ±3%），低频的成片明暗，平地略亮一点、略平；软的积灰斑
      const plate = (A[2] - 0.5) * 0.06 + (clM > 0.5 ? (B[2] - 0.5) * 0.04 : 0);
      const lo = fbm(u0, v0, 2, 3, S + 16);
      let t = 0.92 + plate + (lo - 0.5) * 0.2 + 0.03 * calm;
      t = 0.8 + 0.36 * poster(clamp01((t - 0.72) / 0.42), 4, 0.42);
      const dust = sstep(0.52, 0.72, fbm(u0, v0, 3, 3, S + 17));
      t *= (1 - 0.6 * crack) * (1 - 0.1 * near);
      t = t * (1 - 0.25 * dust) + 1.02 * 0.25 * dust * (1 - crack * 0.6);
      // 高度：缝低（游戏里路面裂缝的余烬按高度 < 0.42 发光，粗缝最低、细缝浅一点），板面平，积灰略高
      const h = clamp01(0.64 - 0.5 * cA - 0.36 * cB - 0.22 * cC - 0.1 * near + 0.06 * dust + 0.04 * (lo - 0.5));
      return { c: [t * 0.5, t * 0.5, t * 0.49], h, ao: 1 - 0.45 * crack - 0.08 * near, rough: 1 };
    },
  },
  // 成片焦痕 + 零星碎石（种子 307）
  p_burn: {
    seed: 307,
    nrm: 1.4,
    fn(u, v, S) {
      const n = fbm(u, v, 3, 3, S);
      let t = 0.7 + 0.5 * poster(clamp01((n - 0.25) / 0.5), 3, 0.3);
      const [f1, , id] = worley(u, v, 22, S + 24, 0.7);
      const peb = id > 0.84 ? 1 - sstep(0.16, 0.24, f1) : 0;
      t = t * (1 - peb) + 1.12 * (0.6 + 0.4 * id) * peb;
      // 拖长的焦黑：斜着拉长的噪声（坐标的系数都是整数，照样四方连续）
      const streak = sstep(0.6, 0.8, fbm(u + v, 3 * (v - u), 2, 2, S + 36)) * sstep(0.45, 0.62, fbm(u, v, 2, 2, S + 40)) * 0.14;
      t *= 1 - streak;
      return { c: [t * 0.5, t * 0.5, t * 0.5], h: clamp01(0.45 + 0.2 * (n - 0.5) + 0.4 * peb), ao: 1 - 0.15 * (1 - peb) * (1 - n), rough: 1 };
    },
  },
  // 有棱面的石头（种子 101）：大面（3 个胞一个周期）为主，一部分大面再分成小面（6 个）；暗缝断断续续、粗细不一，亮边很淡（不读成铺好的卵石）
  p_rock: {
    seed: 101,
    nrm: 1.6,
    fn(u0, v0, S) {
      const [u, v] = warp(u0, v0, 4, 0.1, S + 50);
      const A = worley(u, v, 3, S, 0.8), B = worley(u, v, 6, S + 20, 0.8);
      const useB = A[2] > 0.6, sub = useB ? 1 : 0; // 约四成的大面再分成小面（按大面挑，分界落在大缝上）
      const [f1, f2, id, cx, cy] = useB ? B : A;
      const ang = id * 6.2832, gx = Math.cos(ang), gy = Math.sin(ang);
      const plane = (cx * gx + cy * gy) * (useB ? 0.55 : 0.32);
      const lo = fbm(u, v, 3, 2, S - 94);
      let t = 0.8 + 0.3 * id + plane * 0.5 + (lo - 0.5) * 0.25;
      t = 0.62 + 0.62 * poster(clamp01((t - 0.5) / 0.9), 5, 0.42);
      // 缝：大面之间的缝 + 小面之间的缝（只在簇里），都沿线断开、粗细变化
      const brk = sstep(0.4, 0.58, fbm(u0, v0, 5, 2, S + 80));
      const cA = line(edgePx(A[1] - A[0], 3), 2.2 * brk * (0.6 + 0.6 * fbm(u0, v0, 12, 1, S + 70)));
      const cB = line(edgePx(B[1] - B[0], 6), 1.3 * sub * sstep(0.35, 0.55, fbm(u0, v0, 8, 2, S + 90)));
      const crev = Math.max(cA, cB * 0.85);
      const rim = (1 - sstep(1.5, 5, edgePx(A[1] - A[0], 3))) * brk * 0.5;
      const val = t * (1 - 0.55 * crev) * (1 + 0.08 * rim * (1 - crev));
      const h = clamp01(0.55 + plane * 0.6 + (id - 0.5) * 0.2 - crev * 0.5);
      return { c: [val * 0.5, val * 0.5, val * 0.5], h, ao: 1 - 0.45 * crev, rough: 1 };
    },
  },
  // ---------- tex-t3：第 1 区（霜骨沼泽） ----------
  // 冻住的冰面（种子 401，顶替 Ice002）：大块冰板为主，几道不规则的压裂缝（缝里是淡的霜，不起边、沿线变粗变细、会断开），
  // 一簇簇的地方才有细的碎裂；冰下大片深浅不一的暗青（低频、软分档）、成片发白的霜斑，另有成片不裂的平冰。
  // 只画大形和几道线，没有照片里每 10 cm 一道的细裂网。
  p_ice: {
    seed: 401,
    nrm: 0.9,
    fn(u0, v0, S) {
      // 分区：clM = 碎裂的簇（约四分之一），calm = 不裂的平冰（约三成，大裂缝也在这里断开）
      const clM = sstep(0.52, 0.64, fbm(u0, v0, 3, 3, S + 1));
      const calm = sstep(0.54, 0.66, fbm(u0, v0, 2, 3, S + 3)) * (1 - clM);
      // 冰下的深浅：低频的成片明暗（两个周期叠起来，块的大小不一），软分档成 4 档
      const deep = fbm(u0, v0, 2, 3, S + 20) * 0.6 + fbm(u0, v0, 5, 2, S + 21) * 0.4;
      const dq = poster(clamp01((deep - 0.3) / 0.45), 4, 0.4);
      // 霜斑：一小片一小片发白，边缘软（频率高一点，不出一块特别显眼、一眼看出重复的大白斑）；在深冰上少
      const fr = sstep(0.5, 0.72, fbm(u0, v0, 6, 3, S + 22)) * (0.55 + 0.45 * dq);
      // 压裂缝：2 个胞一个周期（7.5 m 一张 → 约 3.7 m 一块，冻住的湖面是几大块），扭曲得厉害（不读成格子），粗细沿线变化、常常断开
      let [u, v] = warp(u0, v0, 3, 0.22, S + 4);
      [u, v] = warp(u, v, 12, 0.014, S + 5);
      const A = worley(u, v, 2, S + 6, 0.95);
      const wA = 1.8 * sstep(0.28, 0.52, fbm(u0, v0, 7, 2, S + 7)) * (1 - calm) * (0.6 + 0.7 * fbm(u0, v0, 18, 1, S + 8));
      const eA = edgePx(A[1] - A[0], 2), cA = line(eA, wA);
      // 碎裂：5 个胞一个周期，只在簇里，扭得少（冰的裂是直一点的），更细
      const [u2, v2] = warp(u0, v0, 6, 0.05, S + 9);
      const B = worley(u2, v2, 5, S + 11, 0.9);
      const wB = 1.1 * clM * sstep(0.3, 0.5, fbm(u0, v0, 6, 2, S + 12)) * (0.6 + 0.7 * fbm(u0, v0, 20, 1, S + 18));
      const cB = line(edgePx(B[1] - B[0], 5), wB);
      const crack = Math.max(cA, cB * 0.8);
      // 粗缝两边一圈软的发白（冰里的应力霜），很淡
      const halo = (1 - sstep(0, 10, eA)) * sm(clamp01(wA / 1.4)) * 0.6;
      // 冰板之间的色调差很小（±2.5%）
      const plate = (A[2] - 0.5) * 0.05;
      let t = 0.8 + 0.28 * dq + plate + 0.03 * calm;
      t = t * (1 - 0.2 * fr) + 1.12 * 0.2 * fr;
      t = t * (1 + 0.1 * halo) * (1 + 0.24 * crack);
      // 颜色：深处偏青，霜和裂缝是中性的白（平均色在游戏里会被归一掉，这里只留冷暖的起伏）
      const cool = clamp01(1 - dq) * (1 - fr) * (1 - crack) * 0.22;
      // 高度：缝只浅浅地低一点（法线别把亮的霜缝画成暗槽），霜斑略高
      const h = clamp01(0.55 + 0.1 * fr + 0.05 * (dq - 0.5) - 0.1 * crack);
      return { c: [t * 0.5 * (1 - cool), t * 0.5 * (1 - cool * 0.35), t * 0.5 * (1 + cool * 0.25)], h, ao: 1 - 0.05 * crack, rough: clamp01(0.55 + 0.4 * fr + 0.3 * crack) };
    },
  },
  // 带雪的冻泥（种子 503，顶替 Snow013）：被风吹成一条条的积雪（低频、斜着拉长，三档、边缘软），
  // 雪薄的地方露出暗一点的冻土和零星的大颗碎石；雪面上很淡的风纹。
  p_snow: {
    seed: 503,
    nrm: 1.2,
    fn(u, v, S) {
      // 斜着拉长的积雪（坐标系数都是整数，照样四方连续）
      const dr = fbm(u + v, 2 * (v - u), 2, 4, S) * 0.45 + fbm(u, v, 3, 3, S + 5) * 0.35 + fbm(2 * u - v, u + v, 2, 2, S + 7) * 0.2;
      const snow = poster(clamp01((dr - 0.32) / 0.4), 3, 0.2);
      // 冻土：雪薄的地方，色调略暗、带一点低频的斑
      const soil = 0.7 + 0.1 * fbm(u, v, 6, 2, S + 9);
      // 碎石：只在冻土上，少、软边
      const [f1, , id] = worley(u, v, 18, S + 24, 0.75);
      const peb = id > 0.9 ? (1 - sstep(0.14, 0.24, f1)) * (1 - snow) : 0;
      // 风纹：雪面上斜着的一道道很淡的起伏
      const rip = (fbm(3 * (u + v), v - u, 3, 1, S + 30) - 0.5) * 0.06 * snow;
      let t = soil * (1 - snow) + (1.02 + rip) * snow;
      t = t * (1 - 0.6 * peb) + 0.78 * (0.7 + 0.3 * id) * 0.6 * peb;
      const h = clamp01(0.4 + 0.35 * snow + 0.25 * peb + rip);
      return { c: [t * 0.5 * (1 - 0.03 * snow), t * 0.5, t * 0.5 * (1 + 0.03 * snow)], h, ao: 1 - 0.12 * (1 - snow) - 0.15 * peb, rough: 1 };
    },
  },
  // 冻住的层状岩（种子 607，顶替这一区用的 Rock035）：水边的石头和虚空的岩顶（三向投影）。大面为主、一部分再分小面，
  // 面上叠横着的岩层（低频、断续，不是一道道均匀的线），暗缝断开、粗细不一，没有亮边。
  p_frock: {
    seed: 607,
    nrm: 1.5,
    fn(u0, v0, S) {
      const [u, v] = warp(u0, v0, 4, 0.08, S + 50);
      const A = worley(u, v, 3, S, 0.8), B = worley(u, v, 6, S + 20, 0.8);
      const useB = A[2] > 0.62, sub = useB ? 1 : 0;
      const [, , id, cx, cy] = useB ? B : A;
      const ang = id * 6.2832, plane = (cx * Math.cos(ang) + cy * Math.sin(ang)) * (useB ? 0.5 : 0.3);
      // 岩层：v 方向压扁的噪声（v × 4，整数倍，照样四方连续），软分档
      const strata = poster(fbm(u0, 4 * v0 + 0.3 * fbm(u0, v0, 3, 2, S + 61), 3, 3, S + 60), 4, 0.35);
      const lo = fbm(u, v, 3, 2, S + 6);
      let t = 0.78 + 0.22 * id + plane * 0.5 + (lo - 0.5) * 0.2 + (strata - 0.5) * 0.18;
      t = 0.66 + 0.56 * poster(clamp01((t - 0.5) / 0.85), 5, 0.42);
      const brk = sstep(0.38, 0.56, fbm(u0, v0, 5, 2, S + 80));
      const cA = line(edgePx(A[1] - A[0], 3), 2.0 * brk * (0.6 + 0.6 * fbm(u0, v0, 12, 1, S + 70)));
      const cB = line(edgePx(B[1] - B[0], 6), 1.2 * sub * sstep(0.35, 0.55, fbm(u0, v0, 8, 2, S + 90)));
      const crev = Math.max(cA, cB * 0.85);
      const val = t * (1 - 0.5 * crev);
      const h = clamp01(0.55 + plane * 0.6 + (id - 0.5) * 0.2 + (strata - 0.5) * 0.1 - crev * 0.5);
      return { c: [val * 0.5 * 0.985, val * 0.5, val * 0.5 * 1.02], h, ao: 1 - 0.45 * crev, rough: 1 };
    },
  },
  // ---------- tex-rest：第 2 区（雷鸣遗迹） ----------
  // 切好的石板地（种子 701，顶替 monastery_stone_floor）：遗迹里铺的是切过的长方石板，错缝铺成几行（行高、板长都不一样），
  // 板缝里积着砂砾；有的板角崩掉了一块、有的板裂成两半（线断断续续、粗细不一），少数几块整块没了，露出底下的砂砾。
  // 板面色调差很小（±4%）、低频的成片明暗，不画像素级的颗粒；板边只是软地压暗一点，不起亮边。
  p_slab: {
    seed: 701,
    nrm: 1.3,
    fn(u0, v0, S) {
      // 板缝不是尺子画的：低频扭曲 + 一点高频的毛
      let [u, v] = warp(u0, v0, 3, 0.02, S + 1);
      [u, v] = warp(u, v, 16, 0.004, S + 13);
      const L = slabAt(u, v, S);
      const jw = 1.3 + 1.0 * fbm(u0, v0, 10, 2, S + 2); // 板缝半宽（像素）
      const id = L.id;
      // 崩角：板的四个角里有的崩掉一块（多边形一样的不规则缺口，填满砂砾）
      let chip = 0;
      for (let c = 0; c < 4; c++) {
        const hc = hashI(L.key * 4 + c, 17, S + 3);
        if (hc > 0.3) continue;
        const cx = c & 1 ? L.x1 : L.x0, cy = c & 2 ? L.y1 : L.y0;
        const rc = 0.012 + 0.03 * hashI(L.key * 4 + c, 23, S + 4);
        const dx = Math.abs(wrapD(u - cx)), dy = Math.abs(v - cy), a = hashI(L.key * 4 + c, 29, S + 4);
        const d = (a * dx + (1 - a) * dy) * 1.3 + 0.35 * Math.hypot(dx, dy) + (fbm(u0, v0, 18, 2, S + 5) - 0.5) * 0.02;
        chip = Math.max(chip, 1 - sstep(rc - 0.003, rc + 0.003, d));
      }
      const gone = id > 0.975 ? 1 : 0; // 整块没了（很少）
      const dE = L.dE; // 到板缝的距离（像素）
      const joint = Math.max(1 - sstep(jw - 0.7, jw + 0.7, dE), chip, gone);
      // 裂开的板：过板里一点的一道斜线，扭得厉害、断断续续、粗细沿线变化
      let crack = 0;
      if (id < 0.25 && !gone) {
        const a = hashI(L.key, 41, S + 6) * 3.1416, nx = Math.cos(a), ny = Math.sin(a);
        const [cu, cv] = warp(u0, v0, 9, 0.025, S + 14);
        const ox = (hashI(L.key, 43, S + 6) - 0.5) * (L.x1 - L.x0) * 0.4;
        const dd = Math.abs(wrapD(cu - L.cx - ox) * nx + (cv - L.cy) * ny) * N;
        const w = 1.5 * sstep(0.3, 0.48, fbm(u0, v0, 7, 2, S + 7)) * (0.5 + 0.7 * fbm(u0, v0, 20, 1, S + 8));
        crack = line(dd, w) * sstep(jw, jw + 4, dE);
      }
      // 板面：每块一点色调差、一个很缓的坡（磨损不均），低频的成片明暗和磨出来的浅斑，软分档
      const ang = id * 6.2832, plane = (wrapD(u - L.cx) * Math.cos(ang) + (v - L.cy) * Math.sin(ang)) * 3;
      const lo = fbm(u0, v0, 3, 3, S + 10) * 0.6 + fbm(u0, v0, 7, 2, S + 15) * 0.4;
      const wear = sstep(0.55, 0.72, fbm(u0, v0, 5, 3, S + 16));
      let t = 0.93 + (id - 0.5) * 0.07 + plane * 0.05 + (lo - 0.5) * 0.24 + 0.05 * wear;
      t = 0.8 + 0.34 * poster(clamp01((t - 0.72) / 0.42), 4, 0.42);
      const near = (1 - sstep(jw, jw + 7, dE)) * 0.5; // 板边软的一圈压暗（磨圆的边、积灰）
      t *= (1 - 0.1 * near) * (1 - 0.35 * crack);
      // 砂砾：缝里、崩角、空出来的地方；暗一档，带很低频的深浅和零星的大颗
      const [f1, , pid] = worley(u0, v0, 40, S + 17, 0.8);
      const peb = pid > 0.7 ? 1 - sstep(0.18, 0.3, f1) : 0;
      const grit = 0.72 + 0.08 * fbm(u0, v0, 12, 2, S + 11) + 0.12 * peb;
      t = t * (1 - joint) + grit * joint;
      const warm = (hashI(L.key, 53, S + 12) - 0.5) * 0.03 * (1 - joint);
      const h = clamp01((0.62 + plane * 0.04 + (lo - 0.5) * 0.05 - 0.06 * near - 0.12 * crack) * (1 - joint) + (0.26 + 0.06 * fbm(u0, v0, 12, 2, S + 11) + 0.1 * peb) * joint);
      return { c: [t * 0.5 * (1 + warm), t * 0.5, t * 0.5 * (1 - warm)], h, ao: 1 - 0.3 * joint - 0.25 * crack - 0.06 * near, rough: 1 };
    },
  },
  // 砂砾地（种子 809，顶替 rocky_trail）：成片的细砂和碎石（低频分块、边缘软），碎石是零星的大颗（软边），
  // 另有几块棱角分明的碎石板（从墙上、地上崩下来的），成片很淡的水渍。没有照片里满地的小石子颗粒。
  p_grit: {
    seed: 809,
    nrm: 1.3,
    fn(u, v, S) {
      const n = fbm(u, v, 3, 3, S);
      const gravel = sstep(0.48, 0.62, fbm(u, v, 4, 3, S + 3)); // 碎石多的片
      let t = 0.78 + 0.3 * poster(clamp01((n - 0.25) / 0.5), 3, 0.3);
      // 碎石：大颗、少、软边，碎石片里多一些；亮度只比砂高一点（不出亮点）
      const [w0, w1] = warp(u, v, 12, 0.02, S + 22);
      const [f1, , id] = worley(w0, w1, 14, S + 24, 0.8);
      const peb = id > 0.84 - 0.16 * gravel ? 1 - sstep(0.2, 0.32, f1) : 0;
      // 崩下来的碎石板：大一点的胞，挑很少几块，扭过的边（不是方块）
      const [s0, s1] = warp(u, v, 8, 0.05, S + 32);
      const [g1, g2, gid] = worley(s0, s1, 6, S + 30, 0.9);
      const shard = gid > 0.88 ? sstep(0.04, 0.09, g2 - g1) * (1 - sstep(0.26, 0.32, g1)) : 0;
      const stain = sstep(0.55, 0.75, fbm(u, v, 2, 3, S + 40)) * 0.12; // 水渍
      t = t * (1 - peb) + (0.9 + 0.14 * id) * peb;
      t = t * (1 - shard) + (0.96 + 0.3 * (gid - 0.88)) * shard;
      t *= 1 - stain;
      const h = clamp01(0.42 + 0.15 * (n - 0.5) + 0.35 * peb + 0.3 * shard - 0.05 * stain);
      return { c: [t * 0.5, t * 0.5, t * 0.5 * 1.01], h, ao: 1 - 0.18 * (1 - peb) * (1 - n) * (1 - shard), rough: 1 };
    },
  },
  // 成块的层状岩（种子 907，顶替这一区用的 Rock035）：墙外的岩顶和岩石 / 布景的三向投影。切比雪夫距离的胞（横向拉长）
  // 读成一块块方正的岩块（像遗迹墙里崩出来的料），面上有缓坡和横向的岩层，暗缝断开、粗细不一，没有亮边。
  p_srock: {
    seed: 907,
    nrm: 1.5,
    fn(u0, v0, S) {
      const [u, v] = warp(u0, v0, 4, 0.06, S + 50);
      const A = chebCell(u, v, 3, S, 2), B = chebCell(u, v, 6, S + 20, 2);
      const useB = A[2] > 0.6, sub = useB ? 1 : 0;
      const [, , id, cx, cy] = useB ? B : A;
      const ang = id * 6.2832, plane = (cx * Math.cos(ang) + cy * Math.sin(ang)) * (useB ? 0.45 : 0.28);
      const strata = poster(fbm(u0, 4 * v0 + 0.3 * fbm(u0, v0, 3, 2, S + 61), 3, 3, S + 60), 4, 0.35);
      const lo = fbm(u, v, 3, 2, S + 6);
      let t = 0.78 + 0.22 * id + plane * 0.5 + (lo - 0.5) * 0.2 + (strata - 0.5) * 0.14;
      t = 0.66 + 0.56 * poster(clamp01((t - 0.5) / 0.85), 5, 0.42);
      const brk = sstep(0.38, 0.56, fbm(u0, v0, 5, 2, S + 80));
      const cA = line(edgePx(A[1] - A[0], 3), 2.0 * brk * (0.6 + 0.6 * fbm(u0, v0, 12, 1, S + 70)));
      const cB = line(edgePx(B[1] - B[0], 6), 1.2 * sub * sstep(0.35, 0.55, fbm(u0, v0, 8, 2, S + 90)));
      const crev = Math.max(cA, cB * 0.85);
      const val = t * (1 - 0.5 * crev);
      const h = clamp01(0.55 + plane * 0.6 + (id - 0.5) * 0.2 + (strata - 0.5) * 0.1 - crev * 0.5);
      return { c: [val * 0.5 * 1.005, val * 0.5, val * 0.5 * 1.015], h, ao: 1 - 0.45 * crev, rough: 1 };
    },
  },
};

// ---------- 像素 ----------
const q8 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
// 高度 → OpenGL 法线（四方连续）
function normalFrom(H, k) {
  const o = new Uint8Array(N * N * 3), at = (x, y) => H[md(y, N) * N + md(x, N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k, dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1), i = (y * N + x) * 3;
      o[i] = q8((-dx / l) * 0.5 + 0.5);
      o[i + 1] = q8((dy / l) * 0.5 + 0.5);
      o[i + 2] = q8((1 / l) * 0.5 + 0.5);
    }
  }
  return o;
}
// 2×2 盒式缩小（整数运算，低档的 256²）
function half(d, n) {
  const M = n >> 1, o = new Uint8Array(M * M * 3);
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      for (let c = 0; c < 3; c++) {
        const a = d[(2 * y * n + 2 * x) * 3 + c] + d[(2 * y * n + 2 * x + 1) * 3 + c] + d[((2 * y + 1) * n + 2 * x) * 3 + c] + d[((2 * y + 1) * n + 2 * x + 1) * 3 + c];
        o[(y * M + x) * 3 + c] = (a + 2) >> 2;
      }
    }
  }
  return o;
}
// 一张贴图的全部图像：{ 'albedo.jpg': { n, px: Uint8Array RGB }, ... }
function render(id) {
  const T = TEX[id], alb = new Uint8Array(N * N * 3), arh = new Uint8Array(N * N * 3), H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = T.fn((x + 0.5) / N, (y + 0.5) / N, T.seed), i = y * N + x;
      alb[i * 3] = q8(r.c[0]);
      alb[i * 3 + 1] = q8(r.c[1]);
      alb[i * 3 + 2] = q8(r.c[2]);
      H[i] = r.h;
      arh[i * 3] = q8(r.ao);
      arh[i * 3 + 1] = q8(r.rough);
      arh[i * 3 + 2] = q8(r.h);
    }
  }
  return {
    'albedo.jpg': { n: N, px: alb },
    'normal.jpg': { n: N, px: normalFrom(H, T.nrm) },
    'arh.jpg': { n: N, px: arh },
    'lo/albedo.jpg': { n: N >> 1, px: half(alb, N) },
    'lo/arh.jpg': { n: N >> 1, px: half(arh, N) },
  };
}

// ---------- 出口 ----------
// 和 tools/ground-tex.mjs 的 JOBS 同一个格式：make() / lo() → { albedo, normal, arh }（{ N, d: Float32 RGB 0..1 } 的画布，rgba8() 换回来逐字节相同）
const canvas = (im) => {
  const d = new Float32Array(im.px.length);
  for (let i = 0; i < d.length; i++) d[i] = im.px[i] / 255;
  return { N: im.n, d };
};
const cache = Object.create(null);
const R = (id) => cache[id] || (cache[id] = render(id));
export const PAINT_JOBS = {};
for (const id of Object.keys(TEX)) {
  PAINT_JOBS[id] = {
    fn: "paint('" + id + "') 种子 " + TEX[id].seed,
    own: 'tools/gen-paint-textures.mjs', // 由它编码（带 lo、钉住 Chrome 版本），gen-ground-textures.mjs 跳过
    make: () => ({ albedo: canvas(R(id)['albedo.jpg']), normal: canvas(R(id)['normal.jpg']), arh: canvas(R(id)['arh.jpg']) }),
    lo: () => ({ albedo: canvas(R(id)['lo/albedo.jpg']), arh: canvas(R(id)['lo/arh.jpg']) }),
  };
}
