// 地面图层的程序化贴图的像素（只用 Node，不要浏览器）：tools/gen-ground-textures.mjs 拿它编码成 JPEG，tools/check-art.mjs 拿它重新算像素、
// 核对 assets/generated/manifest.json 里的 sha256（同样的代码 → 同样的像素）。
//   g_decals       贴花图集 1024×1024，4×4 格（每格 256 像素，四周留 10 像素透明边免得 mipmap 串格）。
//                  albedo 以灰度为主（游戏里按区域乘顶点色），arh 的 G = 不透明度（three 的 alphaMap 读 G 通道），R = 1，B = 高度。
//   g_cover_<区>   每区一张地面覆盖层（灰烬 / 霜壳 / 砂砾 / 腐壳 / 苔尘）512×512，四方连续：albedo / arh（R 遮蔽 G 粗糙度 B 高度），
//                  地面材质按高度和别的三套混合。法线游戏里不采样（覆盖层按平的法线算），只在这里留着算法。
import crypto from 'node:crypto';

// ---------- 噪声（全部可平铺：坐标按周期 P 取模） ----------
function hashI(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((s | 0) + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const md = (v, P) => ((v % P) + P) % P;
const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const sstep = (a, b, x) => sm((x - a) / (b - a));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// 值噪声：u, v ∈ [0, 1)，P 个格子一个周期
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
// Worley：返回 [F1, F2, 最近点的 id 哈希]，距离以格子为单位
function worley(u, v, P, s, jit = 0.85) {
  const x = u * P, y = v * P, ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = md(ix + i, P), cy = md(iy + j, P);
      const px = ix + i + 0.5 + (hashI(cx, cy, s) - 0.5) * jit, py = iy + j + 0.5 + (hashI(cx, cy, s + 7) - 0.5) * jit;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hashI(cx, cy, s + 13);
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id];
}

// ---------- 画布：Float32 RGB（0..1，sRGB 显示值）----------
function img(N) {
  return { N, d: new Float32Array(N * N * 3) };
}
function set(im, x, y, r, g, b) {
  const o = (y * im.N + x) * 3;
  im.d[o] = r;
  im.d[o + 1] = g;
  im.d[o + 2] = b;
}
// 高度 → OpenGL 法线（+Y 朝上；四方连续时按周期取邻居）
function normalFrom(h, N, k, wrap) {
  const out = img(N);
  const at = (x, y) => (wrap ? h[md(y, N) * N + md(x, N)] : h[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * k, ny = (at(x, y + 1) - at(x, y - 1)) * k, l = Math.hypot(nx, ny, 1);
      set(out, x, y, (nx / l) * 0.5 + 0.5, (ny / l) * 0.5 + 0.5, (1 / l) * 0.5 + 0.5);
    }
  }
  return out;
}

// ---------- 覆盖层（512，四方连续）----------
// 每个函数按 (u, v) 返回 { a: 反照率灰度 / [r,g,b], h: 高度, ao, r: 粗糙度 }；颜色在游戏里乘区域配色，这里只管明暗结构
const COVERS = {
  // 灰烬：平的软积灰（只有很低的起伏，龟裂地的土块从里面拱出来）+ 斑驳的明暗 + 细颗粒 + 零星的白灰片和焦黑的碎屑；不要条纹
  ash(u, v) {
    const lo = fbm(u, v, 3, 4, 11), mid = fbm(u, v, 10, 3, 23), gr = fbm(u, v, 128, 2, 41);
    const w = worley(u, v, 56, 5, 0.9), fl = sstep(0.24, 0.08, w[0]) * (w[2] > 0.8 ? 1 : 0), ch = sstep(0.2, 0.06, w[0]) * (w[2] < 0.08 ? 1 : 0);
    const h = 0.42 + 0.12 * lo + 0.08 * mid + 0.04 * fl;
    const a = 0.6 + 0.1 * (lo - 0.5) + 0.1 * (mid - 0.5) + 0.07 * (gr - 0.5) + 0.16 * fl - 0.3 * ch;
    return { a: [a * 0.99, a * 0.99, a], h, ao: 0.88 + 0.12 * mid, r: 0.97 };
  },
  // 霜壳：冻住的一层白霜，大块的明暗起伏 + 很淡的裂纹（Worley 的块边，只提亮一点）+ 细的结晶噪声和零星的亮点；不要成「铺地砖」的网格
  frost(u, v) {
    const lo = fbm(u, v, 4, 4, 13), w = worley(u, v, 6, 3, 0.9), e = w[1] - w[0];
    const ridge = sstep(0.08, 0.0, e) * (0.4 + 0.6 * fbm(u, v, 12, 2, 15));
    const fine = fbm(u, v, 64, 3, 17), crys = fbm(u, v, 140, 2, 19);
    const spark = hashI(Math.floor(u * 512), Math.floor(v * 512), 99) > 0.988 ? 1 : 0;
    const h = 0.45 + 0.2 * lo + 0.06 * ridge + 0.08 * (fine - 0.5);
    const a = 0.64 + 0.12 * (lo - 0.5) + 0.07 * ridge + 0.1 * (fine - 0.5) + 0.06 * (crys - 0.5) + 0.16 * spark;
    return { a: [a * 0.97, a, a * 1.03], h, ao: 0.85 + 0.15 * lo, r: 0.6 + 0.2 * (1 - ridge) };
  },
  // 砂砾：密的小卵石（每颗明暗不一）+ 石缝里的细砂
  storm(u, v) {
    const w = worley(u, v, 34, 7, 0.95), w2 = worley(u, v, 90, 8, 0.95);
    const peb = sstep(0.62, 0.25, w[0]), peb2 = sstep(0.55, 0.2, w2[0]) * (w2[2] > 0.55 ? 1 : 0);
    const sand = fbm(u, v, 64, 3, 29);
    const h = 0.25 + 0.55 * peb * (0.7 + 0.3 * w[2]) + 0.15 * peb2 + 0.06 * sand;
    const a = 0.42 + 0.28 * peb * (0.55 + 0.45 * w[2]) + 0.12 * peb2 + 0.08 * (sand - 0.5) - 0.1 * (1 - peb) * (1 - peb2);
    return { a: [a, a * 0.99, a * 1.02], h, ao: 0.6 + 0.4 * Math.max(peb, peb2 * 0.7), r: 0.88 };
  },
  // 腐壳：深色的硬壳，被一道道凹下去的脉络切开（脊噪声），壳面上有细的颗粒
  abyss(u, v) {
    const n = fbm(u, v, 6, 4, 51), r = 1 - Math.abs(2 * fbm(u, v, 5, 4, 61) - 1), vein = sstep(0.86, 0.97, r);
    const gr = fbm(u, v, 80, 2, 71), plate = fbm(u, v, 14, 3, 81);
    const h = 0.55 + 0.25 * (plate - 0.5) + 0.1 * (gr - 0.5) - 0.4 * vein;
    const a = 0.5 + 0.18 * (n - 0.5) + 0.12 * (plate - 0.5) + 0.08 * (gr - 0.5) - 0.28 * vein;
    return { a: [a, a * 0.96, a * 1.02], h, ao: 0.7 + 0.3 * (1 - vein), r: 0.7 + 0.2 * vein };
  },
  // 苔尘：不规则的一片片地衣（两层噪声取阈值，边上一圈略亮），片里有细的斑点，片和片之间是细尘
  rift(u, v) {
    const n = fbm(u, v, 8, 4, 91), n2 = fbm(u, v, 28, 3, 93), t = n + 0.3 * (n2 - 0.5);
    const blob = sstep(0.53, 0.57, t), rim = blob * sstep(0.63, 0.57, t);
    const dust = fbm(u, v, 72, 2, 97), sp = fbm(u, v, 110, 2, 99), speck = hashI(Math.floor(u * 512), Math.floor(v * 512), 7) > 0.975 ? 1 : 0;
    const h = 0.4 + 0.22 * blob + 0.06 * rim + 0.06 * (dust - 0.5);
    const a = 0.5 + 0.12 * blob + 0.12 * rim + 0.1 * blob * (sp - 0.5) + 0.08 * (dust - 0.5) + 0.08 * speck * (1 - blob);
    return { a: [a * 0.96, a * 1.02, a], h, ao: 0.78 + 0.22 * (1 - rim * 0.5), r: 0.9 };
  },
};
function genCover(kind, N = 512) {
  const f = COVERS[kind], alb = img(N), arh = img(N), H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const s = f((x + 0.5) / N, (y + 0.5) / N);
      const a = s.a;
      set(alb, x, y, clamp01(a[0]), clamp01(a[1]), clamp01(a[2]));
      H[y * N + x] = clamp01(s.h);
      set(arh, x, y, clamp01(s.ao), clamp01(s.r), clamp01(s.h));
    }
  }
  return { albedo: alb, normal: normalFrom(H, N, 5, true), arh };
}

// ---------- 贴花图集（1024，4×4 格）----------
// 每格函数按 (x, y) ∈ [-1, 1]（格子中心为原点）返回 [灰度, 不透明度, 高度]；出了半径 1 的圆或靠近格边都会被压成透明
const CELL = 256, PADX = 10;
function rnd(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 一组随机折线（裂纹 / 脉络）：返回到最近线段的距离和那段线的宽度
function polyNet(seed, n, len, branchy) {
  const r = rnd(seed), segs = [];
  const walk = (x, y, a, L, w, depth) => {
    const steps = Math.max(3, Math.round(L / 0.06));
    for (let i = 0; i < steps; i++) {
      const na = a + (r() - 0.5) * 0.9, l = (L / steps) * (0.7 + r() * 0.6);
      const nx = x + Math.cos(na) * l, ny = y + Math.sin(na) * l;
      segs.push([x, y, nx, ny, w * (1 - (i / steps) * 0.6)]);
      if (depth < 2 && r() < branchy) walk(nx, ny, na + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.7), L * 0.45, w * 0.6, depth + 1);
      x = nx;
      y = ny;
      a = na * 0.7 + a * 0.3;
    }
  };
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.8;
    walk(Math.cos(a) * 0.08, Math.sin(a) * 0.08, a, len * (0.7 + r() * 0.5), 0.022, 0);
  }
  return (x, y) => {
    let best = 9, bw = 0.01;
    for (const s of segs) {
      const ex = s[2] - s[0], ey = s[3] - s[1];
      let t = ((x - s[0]) * ex + (y - s[1]) * ey) / (ex * ex + ey * ey || 1);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - s[0] - ex * t, y - s[1] - ey * t);
      if (d < best) {
        best = d;
        bw = s[4];
      }
    }
    return [best, bw];
  };
}
// 一堆小石子（椭圆，烘焙了左上受光的明暗和脚下的接触阴影）
function pebbleSet(seed, n, rMin, rMax, spread) {
  const r = rnd(seed), P = [];
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
    P.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, rx: rMin + r() * (rMax - rMin), ry: 0, ang: r() * Math.PI, lum: 0.45 + r() * 0.35, sides: 0 });
    P[i].ry = P[i].rx * (0.6 + r() * 0.35);
    P[i].sides = r() < 0.5 ? 5 + Math.floor(r() * 3) : 0;
  }
  return P;
}
function pebbleSample(P, x, y, angular) {
  let lum = 0, al = 0, h = 0, shadow = 0;
  for (const p of P) {
    const c = Math.cos(p.ang), s = Math.sin(p.ang), dx = x - p.x, dy = y - p.y;
    const lx = (dx * c + dy * s) / p.rx, ly = (-dx * s + dy * c) / p.ry;
    let q = Math.hypot(lx, ly);
    if (angular || p.sides) {
      const k = angular ? 5 : p.sides, th = Math.atan2(ly, lx), seg = (Math.PI * 2) / k;
      q *= Math.cos(seg / 2) / Math.cos(((th % seg) + seg) % seg - seg / 2);
    }
    // 接触阴影：往右下偏一点、比石子大一圈
    const sx = (dx - p.rx * 0.25) / (p.rx * 1.5), sy = (dy - p.ry * 0.3) / (p.ry * 1.5);
    shadow = Math.max(shadow, sstep(1, 0.3, Math.hypot(sx, sy)) * 0.6);
    if (q < 1) {
      const edge = sstep(1, 0.82, q), dome = Math.sqrt(Math.max(0, 1 - q * q));
      const light = 0.55 + 0.45 * clamp01(dome * 0.6 + (-lx * 0.5 - ly * 0.6) * 0.5);
      const v = p.lum * light;
      if (edge > al) {
        lum = v;
        al = edge;
        h = dome;
      }
    }
  }
  // 石子之外的接触阴影：暗、半透明
  const a = Math.max(al, shadow);
  return [(lum * al + 0.05 * (a - al)) / Math.max(a, 1e-4), a, h];
}
const PEB_A = pebbleSet(301, 11, 0.07, 0.17, 0.62), PEB_B = pebbleSet(302, 26, 0.03, 0.08, 0.8), RUB = pebbleSet(303, 9, 0.08, 0.2, 0.6);
const CR_A = polyNet(401, 4, 0.9, 0.35), CR_B = polyNet(402, 2, 1.1, 0.55), VEIN = polyNet(403, 6, 0.85, 0.5);
const DECALS = [
  // 0 焦痕 A：中心最黑，往外一道道放射的烟熏纹，边缘被噪声啃得不规则
  (x, y) => {
    const r = Math.hypot(x, y), th = Math.atan2(y, x), u = (x + 1) / 2, v = (y + 1) / 2;
    const ray = vn((th / Math.PI + 1) / 2, r * 0.3, 18, 5), warp = fbm(u, v, 5, 3, 7);
    const a = sstep(0.95, 0.35, r + 0.35 * (warp - 0.5)) * (0.55 + 0.45 * sstep(0.2, 0.8, ray * 0.6 + (1 - r) * 0.6));
    return [0.1 + 0.18 * r + 0.08 * ray, Math.min(0.92, a * 1.05), 0.5];
  },
  // 1 焦痕 B：几团叠在一起的不规则焦黑，带爆开的细碎点
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = fbm(u, v, 4, 4, 17);
    const b = Math.max(sstep(0.7, 0.2, Math.hypot(x + 0.2, y - 0.1)), sstep(0.55, 0.15, Math.hypot(x - 0.3, y + 0.25)), sstep(0.45, 0.1, Math.hypot(x - 0.1, y - 0.45)));
    const dots = hashI(Math.floor(u * 90), Math.floor(v * 90), 3) > 0.9 ? sstep(1, 0.5, Math.hypot(x, y)) : 0;
    const a = Math.max(sstep(0.25, 0.75, b + 0.45 * (w - 0.5)), dots * 0.8);
    return [0.09 + 0.12 * w, a * 0.9, 0.5];
  },
  // 2 裂纹 A：几道从中心散开的分叉裂缝（线芯黑，两侧一圈很淡的暗边）
  (x, y) => {
    const [d, w] = CR_A(x, y), r = Math.hypot(x, y);
    const a = Math.max(sstep(w, w * 0.35, d), 0.25 * sstep(w * 4, w, d)) * sstep(1, 0.6, r);
    return [0.06, a, 0.2];
  },
  // 3 裂纹 B：一两道长的、分叉多的裂缝
  (x, y) => {
    const [d, w] = CR_B(x, y), r = Math.hypot(x, y);
    const a = Math.max(sstep(w * 0.9, w * 0.3, d), 0.22 * sstep(w * 4, w, d)) * sstep(1, 0.7, r);
    return [0.06, a, 0.2];
  },
  // 4 覆盖斑 A：一片软边的不规则积层（亮，按区域乘成灰 / 霜 / 砂……），里面有斑驳和细碎片
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = fbm(u, v, 5, 4, 27), f = fbm(u, v, 40, 2, 29);
    const a = sstep(0.95, 0.45, Math.hypot(x, y) + 0.5 * (w - 0.5));
    return [0.62 + 0.18 * (f - 0.5) + 0.1 * (w - 0.5), a * (0.75 + 0.25 * f), 0.6];
  },
  // 5 覆盖斑 B：被风拉长的一道积层，带几条细的风纹
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = fbm(u, v, 4, 4, 37), rip = 0.5 + 0.5 * Math.sin((y * 9 + x * 2 + w * 4) * Math.PI);
    const a = sstep(0.95, 0.4, Math.hypot(x * 0.75, y * 1.7) + 0.45 * (w - 0.5));
    return [0.6 + 0.08 * rip + 0.1 * (w - 0.5), a * (0.8 + 0.2 * rip), 0.6];
  },
  // 6 碎砂带：沿 x 拉长的一条砂砾带（路边的过渡用），两端渐隐
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = fbm(u, v, 6, 3, 47);
    const band = sstep(0.75, 0.15, Math.abs(y) + 0.35 * (w - 0.5)) * sstep(1, 0.6, Math.abs(x));
    const g = worley(u, v, 70, 49, 0.95), grain = sstep(0.45, 0.2, g[0]);
    const a = band * (0.35 + 0.65 * grain * (g[2] > 0.25 ? 1 : 0.3));
    return [0.25 + 0.45 * grain * g[2], a, 0.5];
  },
  // 7 石子堆 A：十来颗小石子 + 接触阴影
  (x, y) => pebbleSample(PEB_A, x, y, false),
  // 8 石子 B：散开的细碎石粒
  (x, y) => pebbleSample(PEB_B, x, y, false),
  // 9 接触阴影（圆）：贴在岩石 / 布景脚下的软暗斑
  (x, y) => {
    const r = Math.hypot(x, y);
    return [0.0, Math.pow(clamp01(1 - r * r), 1.6) * 0.95, 0.5];
  },
  // 10 接触阴影（不规则）：墙脚、成簇的石头
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = fbm(u, v, 4, 3, 57), r = Math.hypot(x, y) + 0.35 * (w - 0.5);
    return [0.0, Math.pow(clamp01(1 - r * r), 1.4) * 0.9, 0.5];
  },
  // 11 碎石块：有棱角的碎块（断墙、塌下来的石头）
  (x, y) => pebbleSample(RUB, x, y, true),
  // 12 干涸的水渍：暗的软斑，边上一圈略深的印子
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = fbm(u, v, 5, 3, 67), r = Math.hypot(x, y) + 0.4 * (w - 0.5);
    const a = sstep(0.9, 0.6, r) * 0.55 + 0.35 * sstep(0.1, 0.0, Math.abs(r - 0.78));
    return [0.12, clamp01(a), 0.4];
  },
  // 13 碎斑簇：一团团的小斑点（苔点、霜点、灰点，按区域乘色）
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, w = worley(u, v, 22, 77, 0.95), n = fbm(u, v, 4, 3, 79);
    const a = sstep(0.42, 0.18, w[0]) * (w[2] > 0.35 ? 1 : 0) * sstep(0.95, 0.4, Math.hypot(x, y) + 0.4 * (n - 0.5));
    return [0.55 + 0.25 * w[2], a, 0.6];
  },
  // 14 结晶喷溅：放射的细晶纹（霜 / 晶尘），中心密、往外稀
  (x, y) => {
    const u = (x + 1) / 2, v = (y + 1) / 2, r = Math.hypot(x, y), w = worley(u, v, 26, 87, 0.9);
    const lines = sstep(0.12, 0.0, w[1] - w[0]), n = fbm(u, v, 6, 3, 89);
    const a = (0.25 * sstep(0.9, 0.2, r) + 0.75 * lines * sstep(1, 0.3, r + 0.3 * (n - 0.5)));
    return [0.75 + 0.2 * lines, clamp01(a), 0.6];
  },
  // 15 脉络：从中心往外爬的细脉（腐根 / 枯根），越往外越细
  (x, y) => {
    const [d, w] = VEIN(x, y), r = Math.hypot(x, y);
    const a = Math.max(sstep(w * 1.1, w * 0.4, d), 0.2 * sstep(w * 3.5, w, d)) * sstep(1, 0.55, r);
    return [0.2, a, 0.4];
  },
];
function genDecals() {
  const N = CELL * 4, alb = img(N), arh = img(N);
  for (let c = 0; c < 16; c++) {
    const cx = (c % 4) * CELL, cy = Math.floor(c / 4) * CELL, f = DECALS[c];
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const inner = CELL - 2 * PADX;
        const fx = ((x - PADX + 0.5) / inner) * 2 - 1, fy = ((y - PADX + 0.5) / inner) * 2 - 1;
        let l = 0.5, a = 0, h = 0.5;
        if (Math.abs(fx) < 1 && Math.abs(fy) < 1) {
          [l, a, h] = f(fx, fy);
          a *= sstep(1.0, 0.94, Math.max(Math.abs(fx), Math.abs(fy)));
        }
        // 透明处的颜色取格子的平均灰（mipmap 往外渗的时候不出黑边 / 白边）
        if (a < 0.02) l = 0.35;
        set(alb, cx + x, cy + y, clamp01(l), clamp01(l), clamp01(l));
        set(arh, cx + x, cy + y, 1, clamp01(a), clamp01(h));
      }
    }
  }
  const nrm = img(8);
  for (let i = 0; i < 64; i++) set(nrm, i % 8, Math.floor(i / 8), 0.5, 0.5, 1);
  return { albedo: alb, normal: nrm, arh };
}

// ---------- 出口 ----------
// id → { fn: 生成函数的说明（种子写在代码里）, make: () => { albedo, normal, arh }（Float32 RGB 0..1 的画布） }
export const JOBS = { g_decals: { fn: 'genDecals()', make: () => genDecals() } };
for (const k of Object.keys(COVERS)) JOBS['g_cover_' + k] = { fn: "genCover('" + k + "')", make: () => genCover(k) };
// 画布 → RGBA8（和编码 JPEG 时交给 canvas 的字节一样：四舍五入、α = 255）
export function rgba8(im) {
  const u = new Uint8Array(im.N * im.N * 4);
  for (let i = 0, j = 0; i < im.d.length; i += 3, j += 4) {
    u[j] = Math.round(im.d[i] * 255);
    u[j + 1] = Math.round(im.d[i + 1] * 255);
    u[j + 2] = Math.round(im.d[i + 2] * 255);
    u[j + 3] = 255;
  }
  return u;
}
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
