// 生成特效贴图库（全部程序化、固定种子，输出可重复）：node tools/gen-vfx-textures.mjs [--preview 预览图.png]
// 输出到 assets/vfx/*.png，再由 node tools/pack-assets.mjs 打进 js/assets/vfx.js（index.html 同步引入，游戏端见 js/vfx.js）。
// 只用 Node 自带模块（zlib 压 PNG）。每张图都是 RGB 三个通道各放一样东西（不用 alpha 通道存数据：
// 有的浏览器解码图片时会预乘 alpha，透明处的颜色会丢）。
//   noise-a.png  128²  R 分形噪声（perlin fbm，四方连续）/ G 沃罗诺伊 F1 距离（胞腔，中心暗）/ B 沃罗诺伊胞腔边（裂纹线，边上亮）
//   noise-b.png  128²  R 条纹（竖向拉长的流纹，四方连续）/ G 细碎的高频 fbm / B 每个胞腔一个随机灰度（碎块 / 晶面）
//   ramps.png    64×8  每行一条色带（左暗右亮，sRGB），行号见 RAMPS；着色器按 (亮度, 行) 取色
//   flip-a.png   256²  4×4 帧、每帧 64²：R 火舌 / G 烟团 / B 火花（星芒）
//   flip-b.png   256²  4×4 帧、每帧 64²：R 冲击环 / G 斩击弧 / B 电弧
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets/vfx');

// ---------- PNG（8 位 RGB，逐行挑最省的滤波） ----------
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgb) {
  const bpp = 3, stride = w * bpp, raw = Buffer.alloc((stride + 1) * h), tmp = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = rgb.subarray(y * stride, (y + 1) * stride), prev = y ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity, bestBuf = null;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
        let p;
        if (f === 0) p = 0;
        else if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else {
          const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[i] - p) & 0xff;
        tmp[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
        bestBuf = Buffer.from(tmp);
      }
    }
    raw[y * (stride + 1)] = best;
    bestBuf.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 随机与噪声（全部固定种子、按周期取模，四方连续） ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
// 周期 P（横）× PY（纵，缺省同 P）的梯度噪声（perlin）：格点上放随机单位向量
function makePerlin(P, seed, PY) {
  PY = PY || P;
  const rnd = mulberry32(seed), gx = new Float32Array(P * PY), gy = new Float32Array(P * PY);
  for (let i = 0; i < P * PY; i++) {
    const a = rnd() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const dot = (ix, iy, dx, dy) => {
      const k = (((iy % PY) + PY) % PY) * P + (((ix % P) + P) % P);
      return gx[k] * dx + gy[k] * dy;
    };
    const u = fade(fx), v = fade(fy);
    const a = dot(xi, yi, fx, fy), b = dot(xi + 1, yi, fx - 1, fy), c = dot(xi, yi + 1, fx, fy - 1), d = dot(xi + 1, yi + 1, fx - 1, fy - 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.414; // 约 -1..1
  };
}
// 四方连续的 fbm：第 o 层周期 P0·2^o、频率同步翻倍
function makeFbm(P0, oct, seed, gain = 0.5) {
  const L = [];
  for (let o = 0; o < oct; o++) L.push(makePerlin(P0 << o, seed + o * 101));
  return (u, v) => {
    let s = 0, a = 1, n = 0;
    for (let o = 0; o < oct; o++) {
      const f = P0 << o;
      s += L[o](u * f, v * f) * a;
      n += a;
      a *= gain;
    }
    return s / n; // 约 -1..1
  };
}
// 周期沃罗诺伊：N×N 格，每格一个抖动点；返回 [F1, F2, 最近点的随机值]
function makeVoronoi(N, seed) {
  const rnd = mulberry32(seed), px = new Float32Array(N * N), py = new Float32Array(N * N), id = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    px[i] = 0.1 + rnd() * 0.8;
    py[i] = 0.1 + rnd() * 0.8;
    id[i] = rnd();
  }
  return (u, v) => {
    const x = u * N, y = v * N, xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, c = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const cx = xi + i, cy = yi + j, k = (((cy % N) + N) % N) * N + (((cx % N) + N) % N);
      const dx = cx + px[k] - x, dy = cy + py[k] - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; c = id[k]; } else if (d < f2) f2 = d;
    }
    return [f1, f2, c];
  };
}
// 把一组浮点值按分位数拉到 0..1（让每个通道都用满 8 位）
function normalize(arr, lo = 0.01, hi = 0.99) {
  const s = Float32Array.from(arr).sort();
  const a = s[Math.floor(s.length * lo)], b = s[Math.floor(s.length * hi)];
  for (let i = 0; i < arr.length; i++) arr[i] = clamp01((arr[i] - a) / (b - a || 1));
  return arr;
}

// ---------- 噪声贴图 ----------
function noiseA(S) {
  const fb = makeFbm(4, 5, 11), vo = makeVoronoi(8, 23);
  const R = new Float32Array(S * S), G = new Float32Array(S * S), B = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, i = y * S + x;
    R[i] = fb(u, v);
    const [f1, f2] = vo(u, v);
    G[i] = f1;
    B[i] = 1 - smooth(0.0, 0.16, f2 - f1); // 胞腔边：F2 − F1 小的地方亮
  }
  normalize(R);
  normalize(G, 0, 0.995);
  return [R, G, B];
}
function noiseB(S) {
  const st = makePerlin(16, 37, 1), st2 = makePerlin(32, 41, 2), fbV = makeFbm(2, 3, 43), fine = makeFbm(16, 3, 53), vo = makeVoronoi(10, 61);
  const R = new Float32Array(S * S), G = new Float32Array(S * S), B = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, i = y * S + x;
    // 条纹：横向高频、纵向只有 1～2 个周期，再用低频噪声把条纹扭一扭
    const w = fbV(u, v) * 0.6;
    const s = st(u * 16 + w * 4, v * 1) * 0.65 + st2(u * 32 + w * 6, v * 2) * 0.35;
    R[i] = Math.pow(clamp01(s * 0.5 + 0.5), 1.6);
    G[i] = fine(u, v);
    B[i] = vo(u, v)[2];
  }
  normalize(R);
  normalize(G);
  return [R, G, B];
}

// ---------- 色带（sRGB，左暗右亮；4 档阶梯 + 1 像素过渡，卡通的硬色带） ----------
// 每条：[名字, [阈值, 颜色]...]，阈值以下取上一个颜色；最左一档是「几乎透明」的暗色（着色器里亮度低的地方 alpha 也低）
const RAMPS = [
  ['fire', [[0, 0x2a0806], [0.18, 0xc22c18], [0.45, 0xff8424], [0.78, 0xfff0b0]]],
  ['frost', [[0, 0x0a1838], [0.18, 0x2458d0], [0.45, 0x78ccff], [0.78, 0xf0fbff]]],
  ['light', [[0, 0x2a1a04], [0.18, 0xc8820e], [0.45, 0xffdc40], [0.78, 0xfffbe0]]],
  ['chaos', [[0, 0x12061a], [0.18, 0x3a0c46], [0.45, 0xf03cb4], [0.78, 0xffd2f2]]],
  ['abyss', [[0, 0x050208], [0.18, 0x1c0a2c], [0.45, 0x6a2a9a], [0.78, 0xc8a0ff]]],
  ['holy', [[0, 0x2c2214], [0.18, 0xb08a4a], [0.45, 0xf0d89a], [0.78, 0xfffaf0]]],
  ['poison', [[0, 0x0a1406], [0.18, 0x3c7a18], [0.45, 0x9ae044], [0.78, 0xeaffc0]]],
  ['ash', [[0, 0x0c0a0e], [0.18, 0x3a3440], [0.45, 0x7a7080], [0.78, 0xc8c0cc]]],
];
function ramps(Wd) {
  const H = RAMPS.length, rgb = Buffer.alloc(Wd * H * 3);
  const hx = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  for (let r = 0; r < H; r++) {
    const stops = RAMPS[r][1];
    for (let x = 0; x < Wd; x++) {
      const t = (x + 0.5) / Wd;
      let k = 0;
      while (k + 1 < stops.length && t >= stops[k + 1][0]) k++;
      let c = hx(stops[k][1]);
      // 跨档处 1 像素的过渡（线性过滤时不出锯齿）
      if (k + 1 < stops.length && Math.abs(t - stops[k + 1][0]) < 1 / Wd) {
        const n = hx(stops[k + 1][1]);
        c = c.map((v, j) => Math.round((v + n[j]) / 2));
      }
      const o = (r * Wd + x) * 3;
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  }
  return rgb;
}

// ---------- 序列帧（4×4，每帧 F²；每个函数返回 (帧, u, v) → 0..1，u/v 在帧内 0..1，v 向下） ----------
const NF = 16;
// 火舌：底宽顶尖、往上舔的一条火苗；噪声沿 v 往上滚（时间方向四方连续，16 帧首尾接得上）
function fireLick() {
  const n1 = makePerlin(8, 71), n2 = makePerlin(16, 73);
  return (f, u, v) => {
    const t = f / NF, x = u * 2 - 1, h = 1 - v; // h：0 底 → 1 顶
    const sway = 0.12 * Math.sin((h * 2.2 + t) * Math.PI * 2) * h;
    const wid = 0.62 * Math.pow(1 - h, 0.7) * (h < 0.12 ? Math.sqrt(h / 0.12) : 1);
    const e = Math.abs(x - sway) / Math.max(wid, 1e-3);
    const nz = n1(u * 4, (h - t) * 8) * 0.55 + n2(u * 8, (h - t) * 16) * 0.3; // 往上滚
    const body = 1 - e + nz * 0.55 - h * 0.25;
    const core = clamp01((1 - e * 1.6) * (1 - h * 1.1)) * 0.5;
    return clamp01(smooth(0.05, 0.45, body) * 0.75 + core) * smooth(1.0, 0.86, h);
  };
}
// 烟团：先小后大、慢慢被噪声蚀空的一团（几个鼓包叠起来）
function smokePuff() {
  const fb = makeFbm(4, 4, 81), rnd = mulberry32(83), lobes = [];
  for (let i = 0; i < 6; i++) lobes.push([rnd() * 2 - 1, rnd() * 2 - 1, 0.45 + rnd() * 0.3]);
  return (f, u, v) => {
    const t = f / (NF - 1), x = u * 2 - 1, y = v * 2 - 1;
    const grow = 0.35 + 0.6 * (1 - Math.pow(1 - t, 2));
    let d = 0;
    for (const [lx, ly, lr] of lobes) {
      const dx = x - lx * 0.36 * grow, dy = y - ly * 0.32 * grow, r = lr * grow * 1.15;
      d = Math.max(d, 1 - Math.sqrt(dx * dx + dy * dy) / r);
    }
    const nz = fb(u + t * 0.15, v - t * 0.2) * 0.5 + 0.5;
    const dens = d * 1.5 - Math.pow(t, 1.5) * 0.95 + (nz - 0.5) * 0.8; // 越往后蚀得越空
    return clamp01(smooth(0.0, 0.35, dens)) * (0.55 + 0.45 * nz);
  };
}
// 火花：中心一闪、八道芒刺先伸后收，越往后越细
function sparkBurst() {
  const rnd = mulberry32(91), rays = [];
  for (let i = 0; i < 9; i++) rays.push([(i / 9) * Math.PI * 2 + (rnd() - 0.5) * 0.4, 0.6 + rnd() * 0.4]);
  return (f, u, v) => {
    const t = f / (NF - 1), x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x);
    const reach = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5), shrink = 1 - smooth(0.5, 1.0, t);
    let s = 0;
    for (const [ra, rl] of rays) {
      let da = (((a - ra) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      da = Math.min(da, Math.PI * 2 - da);
      const L = rl * 0.95 * reach, w = 0.16 * (1 - r / Math.max(L, 1e-3)) * shrink;
      if (r < L && da * Math.max(r, 0.05) < w * 0.5) s = Math.max(s, (1 - r / L) * 0.7 + 0.3);
    }
    const flash = Math.max(0, 1 - r / (0.35 * (1 - t))) * (1 - t);
    return clamp01(Math.max(s * shrink, flash));
  };
}
// 冲击环：从里往外扩、越扩越细，环身被噪声打出缺口
function shockRing() {
  const n = makePerlin(8, 101);
  return (f, u, v) => {
    const t = f / (NF - 1), x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x) / (Math.PI * 2) + 0.5;
    const rr = 0.12 + 0.8 * (1 - Math.pow(1 - t, 2)), w = 0.03 + 0.17 * (1 - t);
    const band = 1 - Math.abs(r - rr) / w;
    const gap = n(a * 8, t * 2) * 0.5 + 0.5;
    const lead = smooth(rr - w * 0.4, rr, r); // 外沿更亮
    return clamp01(smooth(0.0, 0.3, band) * (0.55 + 0.45 * lead) * smooth(0.18 + t * 0.4, 0.42 + t * 0.4, gap + 0.25));
  };
}
// 斩击弧：一弯月牙从左扫到右（前半段扫开，后半段尾巴追上来、越来越细），v 向下 = 弧在帧的上半
function slashArc() {
  const n = makePerlin(16, 111);
  return (f, u, v) => {
    const t = f / (NF - 1), x = u * 2 - 1, y = 1 - v * 2, r = Math.hypot(x, y + 0.9), a = Math.atan2(x, y + 0.9);
    const A = 0.78, h = (a / A) * 0.5 + 0.5; // 0 左端 → 1 右端
    if (h < 0 || h > 1) return 0;
    const head = Math.min(1, t * 2.2), tailEnd = Math.max(0, (t - 0.35) * 1.6); // 前沿、尾端
    if (h > head || h < tailEnd) return 0;
    const span = Math.max(head - tailEnd, 1e-3), k = (head - h) / span; // 0 前沿 → 1 尾端
    const ends = Math.min(1, Math.min(h, 1 - h) * 5);
    const th = 0.3 * (1 - k * k * 0.85) * ends * (1 - 0.5 * smooth(0.5, 1, t)), s = (r - (1.25 - th)) / Math.max(th, 1e-3);
    if (s < 0 || s > 1) return 0;
    const nz = n(h * 16, s * 4) * 0.12;
    return clamp01((0.3 + 0.7 * s) * (1 - k * 0.5) + nz);
  };
}
// 电弧：横贯整帧的锯齿亮线（每帧重新折一次），两头在帧的中线上（横向拼接时接得上）
function electricArc() {
  const rnd = mulberry32(121), frames = [];
  for (let f = 0; f < NF; f++) {
    const pts = [[0, 0.5]];
    for (let k = 1; k < 8; k++) pts.push([k / 8, 0.5 + (rnd() - 0.5) * 0.5]);
    pts.push([1, 0.5]);
    const fork = [Math.floor(2 + rnd() * 4), (rnd() < 0.5 ? -1 : 1) * (0.15 + rnd() * 0.2)];
    frames.push({ pts, fork });
  }
  const segD = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
    return Math.hypot(px - ax - dx * t, py - ay - dy * t);
  };
  return (f, u, v) => {
    const { pts, fork } = frames[f];
    let d = 9;
    for (let k = 0; k + 1 < pts.length; k++) d = Math.min(d, segD(u, v, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
    const [fk, fy] = fork, a = pts[fk], b = [a[0] + 0.12, a[1] + fy], c = [b[0] + 0.1, b[1] + fy * 0.6];
    const dF = Math.min(segD(u, v, a[0], a[1], b[0], b[1]), segD(u, v, b[0], b[1], c[0], c[1])) * 1.6;
    d = Math.min(d, dF);
    return clamp01(Math.max(1 - d / 0.022, 0) * 0.85 + Math.max(0, 1 - d / 0.09) * 0.3);
  };
}
function atlas(F, fns) {
  const S = F * 4, rgb = Buffer.alloc(S * S * 3);
  fns.forEach((fn, ch) => {
    if (!fn) return;
    for (let f = 0; f < NF; f++) {
      const ox = (f % 4) * F, oy = Math.floor(f / 4) * F;
      for (let y = 0; y < F; y++) for (let x = 0; x < F; x++) {
        // 每帧四周留 1 像素黑边：线性过滤 / 多级纹理时不串到隔壁帧
        const edge = x === 0 || y === 0 || x === F - 1 || y === F - 1;
        const val = edge ? 0 : fn(f, (x + 0.5) / F, (y + 0.5) / F);
        rgb[((oy + y) * S + ox + x) * 3 + ch] = Math.round(clamp01(val) * 255);
      }
    }
  });
  return rgb;
}
function packRGB(S, chans) {
  const rgb = Buffer.alloc(S * S * 3);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(clamp01(chans[c][i]) * 255);
  return rgb;
}

// ---------- 输出 ----------
const files = [];
function out(name, w, h, rgb) {
  const png = encodePNG(w, h, rgb);
  fs.writeFileSync(path.join(outDir, name), png);
  files.push({ name, w, h, rgb, bytes: png.length });
}
fs.mkdirSync(outDir, { recursive: true });
const NS = 128, F = 64;
out('noise-a.png', NS, NS, packRGB(NS, noiseA(NS)));
out('noise-b.png', NS, NS, packRGB(NS, noiseB(NS)));
out('ramps.png', 64, RAMPS.length, ramps(64));
out('flip-a.png', F * 4, F * 4, atlas(F, [fireLick(), smokePuff(), sparkBurst()]));
out('flip-b.png', F * 4, F * 4, atlas(F, [shockRing(), slashArc(), electricArc()]));
let tot = 0;
for (const f of files) {
  tot += f.bytes;
  console.log(f.name.padEnd(12), f.w + '×' + f.h, (f.bytes / 1024).toFixed(1) + ' KB');
}
console.log('合计', (tot / 1024).toFixed(1) + ' KB（base64 约 ' + ((tot * 4) / 3 / 1024).toFixed(1) + ' KB）');
console.log('色带行号：' + RAMPS.map((r, i) => i + '=' + r[0]).join(' '));

// --preview：每个通道单独铺成灰度图、色带放大，拼成一张检查用的预览（不进仓库）
const pi = process.argv.indexOf('--preview');
if (pi > 0) {
  const tiles = [];
  for (const f of files) {
    if (f.name === 'ramps.png') continue;
    for (let c = 0; c < 3; c++) tiles.push({ f, c });
  }
  const T = 256, cols = 6, rows = Math.ceil(tiles.length / cols), rampH = 8 * 16, PW = cols * T, PH = rows * T + rampH;
  const rgb = Buffer.alloc(PW * PH * 3);
  tiles.forEach(({ f, c }, k) => {
    const ox = (k % cols) * T, oy = Math.floor(k / cols) * T;
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const sx = Math.floor((x / T) * f.w * (f.w < T ? 2 : 1)) % f.w, sy = Math.floor((y / T) * f.h * (f.h < T ? 2 : 1)) % f.h; // 噪声铺 2×2 看接缝
      const v = f.rgb[(sy * f.w + sx) * 3 + c], o = ((oy + y) * PW + ox + x) * 3;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
    }
  });
  const rf = files.find((f) => f.name === 'ramps.png');
  for (let y = 0; y < rampH; y++) for (let x = 0; x < PW; x++) {
    const sx = Math.min(rf.w - 1, Math.floor((x / PW) * rf.w)), sy = Math.floor(y / 16), o = ((rows * T + y) * PW + x) * 3, s = (sy * rf.w + sx) * 3;
    rgb[o] = rf.rgb[s]; rgb[o + 1] = rf.rgb[s + 1]; rgb[o + 2] = rf.rgb[s + 2];
  }
  fs.mkdirSync(path.dirname(path.resolve(process.argv[pi + 1])), { recursive: true });
  fs.writeFileSync(path.resolve(process.argv[pi + 1]), encodePNG(PW, PH, rgb));
  console.log('预览', process.argv[pi + 1]);
}
