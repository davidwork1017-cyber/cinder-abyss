// 脚本画的地面 / 岩石平铺贴图（「画出来的」卡通风格，顶替照片 PBR 贴图；我们自己画的，原创）：
//   p_mud    第 0 区路面（顶替 mud_cracked_dry_03）：烧干龟裂的焦土。裂纹分三级而且不均匀：大部分是几块大板，
//            一簇簇的地方才碎成中块 / 小块，另有成片不裂的平地；裂缝粗细沿线变化、两头收尖、中间会断开，读起来是裂开的地，不是一张网。
//   p_burn   第 0 区粗糙地面（顶替 burned_ground_01）：低频的成片焦痕（三档色调，边缘软）+ 零星的大颗碎石 + 拖长的焦黑。
//   p_rock   第 0 区虚空地面和岩壁 / 布景的三向投影（第 0 区不再用照片 dark_rock）：有棱面的石头，每个面一个平的色调 + 面内一道渐变，窄的暗缝。
// 每张出 512² 的 albedo / normal / arh（R 遮蔽 G 粗糙度 B 高度，和 prep-textures.mjs 的格式一样），
// 另出低档用的 256² 一套 lo/albedo、lo/arh（2×2 盒式缩小；低档不传法线贴图，游戏里用平的法线）。
// 像素全部在 Node 里按固定种子算（同样的代码 → 同样的像素，原始像素的 sha256 记进 assets/generated/manifest.json）；
// JPEG（q 0.84）借 playwright-core 起的 Chrome 的 canvas 编码（和 gen-ground-textures.mjs 一样），Chrome 版本钉在 manifest 里：
// 版本不同就拒绝重编码（JPEG 字节会变），要换版本时加 --rebase 重新生成并提交新的 sha256。
// 用法：
//   node tools/gen-paint-textures.mjs [--rebase] [id ...]   生成 assets/generated/<id>/ 并更新 manifest，然后 node tools/pack-assets.mjs 重新打包
//   node tools/gen-paint-textures.mjs --check               只用 Node：重算像素核对 manifest 里的像素 sha256，再核对仓库里 JPEG 的 sha256（不起浏览器）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'assets/generated');
const manPath = path.join(outRoot, 'manifest.json');
const Q = 0.84, N = 512;

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const args = process.argv.slice(2);
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : {};
const paint = (man.paint = man.paint || { _comment: '', encoder: {}, textures: {} });

if (args.includes('--check')) {
  // 只用 Node：像素重算 + JPEG 字节核对（check-art 调这一步）
  let bad = 0;
  for (const id of Object.keys(TEX)) {
    const e = paint.textures[id];
    if (!e) {
      console.error('manifest 里没有 ' + id);
      bad++;
      continue;
    }
    const imgs = render(id);
    for (const [f, im] of Object.entries(imgs)) {
      const m = e.files[f], file = path.join(outRoot, id, f);
      if (!m) {
        console.error(id + '/' + f + '：manifest 里没有');
        bad++;
        continue;
      }
      if (sha(im.px) !== m.px) (bad++, console.error(id + '/' + f + '：像素和 manifest 不一致（生成器改了要重新生成）'));
      if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== m.jpg) (bad++, console.error(id + '/' + f + '：JPEG 和 manifest 不一致'));
    }
  }
  console.log(bad ? '贴图核对失败：' + bad + ' 处' : '贴图核对通过：' + Object.keys(TEX).join(' '));
  process.exit(bad ? 1 : 0);
}

const pv = args.indexOf('--preview');
if (pv >= 0) {
  // 调参用：不起浏览器，把原始像素写成 PNG（不进仓库）
  const dir = args[pv + 1], zlib = await import('node:zlib');
  const chunk = (t, d) => {
    const len = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
    len.writeUInt32BE(d.length);
    c.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const png = (n, px) => {
    const raw = Buffer.alloc(n * (n * 3 + 1)), hd = Buffer.alloc(13);
    for (let y = 0; y < n; y++) Buffer.from(px.buffer, px.byteOffset + y * n * 3, n * 3).copy(raw, y * (n * 3 + 1) + 1);
    hd.writeUInt32BE(n, 0);
    hd.writeUInt32BE(n, 4);
    hd[8] = 8;
    hd[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hd), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  for (const id of Object.keys(TEX)) {
    if (args.slice(pv + 2).length && !args.slice(pv + 2).includes(id)) continue;
    const R = render(id);
    for (const [f, im] of Object.entries(R)) {
      const file = path.join(dir, id + '_' + f.replace('/', '_').replace('.jpg', '.png'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, png(im.n, im.px));
    }
    // 2×2 平铺、对比度拉到 2.5 倍、缩到一半：看重复和整体的疏密
    const a = R['albedo.jpg'].px, t = new Uint8Array(N * N * 3);
    let mean = 0;
    for (let i = 0; i < a.length; i++) mean += a[i];
    mean /= a.length;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 3; c++) {
      const sx = (x * 2) % N, sy = (y * 2) % N;
      const v = (a[(sy * N + sx) * 3 + c] + a[(sy * N + sx + 1) * 3 + c] + a[((sy + 1) % N * N + sx) * 3 + c] + a[((sy + 1) % N * N + sx + 1) * 3 + c]) / 4;
      t[(y * N + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(128 + (v - mean) * 2.5)));
    }
    fs.writeFileSync(path.join(dir, id + '_tile2x2.png'), png(N, t));
  }
  process.exit(0);
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ver = browser.version();
const rebase = args.includes('--rebase');
if (paint.encoder.chrome && paint.encoder.chrome !== ver && !rebase) {
  await browser.close();
  throw new Error('JPEG 编码器版本不同：manifest 钉的是 Chrome ' + paint.encoder.chrome + '，现在是 ' + ver + '（确实要换就加 --rebase，重新提交所有 JPEG）');
}
const page = await browser.newPage();
const only = args.filter((a) => !a.startsWith('--'));
let total = 0;
for (const id of Object.keys(TEX)) {
  if (only.length && !only.includes(id)) continue;
  const t0 = Date.now(), imgs = render(id), files = {};
  for (const [f, im] of Object.entries(imgs)) {
    const rgba = new Uint8Array(im.n * im.n * 4);
    for (let i = 0, j = 0; i < im.px.length; i += 3, j += 4) {
      rgba[j] = im.px[i];
      rgba[j + 1] = im.px[i + 1];
      rgba[j + 2] = im.px[i + 2];
      rgba[j + 3] = 255;
    }
    const url = await page.evaluate(
      ([b64, n, q]) => {
        const bin = atob(b64), u = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const c = document.createElement('canvas');
        c.width = c.height = n;
        c.getContext('2d').putImageData(new ImageData(u, n, n), 0, 0);
        return c.toDataURL('image/jpeg', q);
      },
      [Buffer.from(rgba).toString('base64'), im.n, Q]
    );
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'), file = path.join(outRoot, id, f);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    files[f] = { n: im.n, px: sha(im.px), jpg: sha(buf), bytes: buf.length };
    total += buf.length;
  }
  paint.textures[id] = { gen: 'tools/gen-paint-textures.mjs', seed: TEX[id].seed, files };
  console.log(id.padEnd(8), ((Date.now() - t0) / 1000).toFixed(1) + ' s', Object.values(files).map((x) => (x.bytes / 1024).toFixed(0)).join(' / ') + ' KB');
}
await browser.close();
paint._comment = '脚本画的平铺贴图（tools/gen-paint-textures.mjs）。px = 原始 RGB 像素的 sha256（node tools/gen-paint-textures.mjs --check 只用 Node 重算核对），jpg = 仓库里 JPEG 的 sha256；JPEG 由下面这个版本的 Chrome 编码（q 0.84），换版本要 --rebase';
paint.encoder = { chrome: ver, q: Q, via: 'playwright-core channel chrome, canvas.toDataURL' };
fs.writeFileSync(manPath, JSON.stringify(man, null, 1) + '\n');
console.log('合计', (total / 1024).toFixed(0) + ' KB');
