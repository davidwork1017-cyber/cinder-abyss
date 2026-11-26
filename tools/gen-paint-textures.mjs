// 脚本画的地面 / 岩石平铺贴图（第 0 区 p_mud / p_burn / p_rock，第 1 区 p_ice / p_snow / p_frock，像素在 tools/paint-tex.mjs）的编码：JPEG q 0.84，借 playwright-core 起的 Chrome 的 canvas
// （和 gen-ground-textures.mjs 一样）。原始像素（RGBA8）和 JPEG 的 sha256 写进 assets/generated/manifest.json（格式同 gen-ground-textures.mjs，另有 lo 和 enc）。
// Chrome 版本钉在每条的 enc 里：版本不同就拒绝重新编码（JPEG 字节会变），确实要换版本时加 --rebase，重新生成并提交所有 JPEG。
// 用法：
//   node tools/gen-paint-textures.mjs [--rebase] [id ...]   生成 assets/generated/<id>/（含 lo/）并更新清单，然后 node tools/pack-assets.mjs 重新打包
//   node tools/gen-paint-textures.mjs --check               只用 Node：重算像素核对清单里的像素 sha256，再核对仓库里 JPEG 的 sha256（不起浏览器）
//   node tools/gen-paint-textures.mjs --preview <目录> [id]  调参用：原始像素写成 PNG（含 2×2 平铺、对比度 ×2.5 的一张），不进仓库
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PAINT_JOBS } from './paint-tex.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'assets/generated');
const manPath = path.join(outRoot, 'manifest.json');
const Q = 0.84;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// 画布 → RGBA8（和 ground-tex.mjs 的 rgba8 一样：四舍五入、α = 255；也就是交给 canvas 编码的字节）
function rgba8(im) {
  const u = new Uint8Array(im.N * im.N * 4);
  for (let i = 0, j = 0; i < im.d.length; i += 3, j += 4) {
    u[j] = Math.round(im.d[i] * 255);
    u[j + 1] = Math.round(im.d[i + 1] * 255);
    u[j + 2] = Math.round(im.d[i + 2] * 255);
    u[j + 3] = 255;
  }
  return u;
}
// 一张贴图要出的图：[清单里的位置, 文件名, 画布]
function images(id) {
  const J = PAINT_JOBS[id], full = J.make(), lo = J.lo(), out = [];
  for (const k of ['albedo', 'normal', 'arh']) out.push(['maps', k, k + '.jpg', full[k]]);
  for (const k of ['albedo', 'arh']) out.push(['lo', k, 'lo/' + k + '.jpg', lo[k]]);
  return out;
}

const args = process.argv.slice(2);
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : {};
man.textures = man.textures || {};

if (args.includes('--check')) {
  let bad = 0;
  const fail = (m) => (bad++, console.error(m));
  for (const id of Object.keys(PAINT_JOBS)) {
    const e = man.textures[id];
    if (!e) {
      fail('清单里没有 ' + id);
      continue;
    }
    for (const [sec, k, f, im] of images(id)) {
      const m = sec === 'lo' ? e.lo && e.lo.maps[k] : e.maps[k], file = path.join(outRoot, id, f);
      if (!m) {
        fail(id + '/' + f + '：清单里没有');
        continue;
      }
      if (sha(rgba8(im)) !== m.pix) fail(id + '/' + f + '：像素和清单不一致（改了 tools/paint-tex.mjs 要重新生成）');
      if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== m.jpg) fail(id + '/' + f + '：JPEG 和清单不一致');
    }
  }
  console.log(bad ? '贴图核对失败：' + bad + ' 处' : '贴图核对通过：' + Object.keys(PAINT_JOBS).join(' '));
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
  const rgb = (im) => { const u = rgba8(im), o = new Uint8Array(im.N * im.N * 3); for (let i = 0, j = 0; j < u.length; i += 3, j += 4) { o[i] = u[j]; o[i + 1] = u[j + 1]; o[i + 2] = u[j + 2]; } return o; };
  for (const id of Object.keys(PAINT_JOBS)) {
    if (args.slice(pv + 2).length && !args.slice(pv + 2).includes(id)) continue;
    let A = null;
    for (const [, k, f, im] of images(id)) {
      const file = path.join(dir, id + '_' + f.replace('/', '_').replace('.jpg', '.png'));
      fs.mkdirSync(dir, { recursive: true });
      const px = rgb(im);
      if (f === 'albedo.jpg') A = px;
      fs.writeFileSync(file, png(im.N, px));
    }
    // 2×2 平铺、对比度拉到 2.5 倍、缩到一半：看重复和整体的疏密
    const N = 512, a = A, t = new Uint8Array(N * N * 3);
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
const pinned = [...new Set(Object.keys(PAINT_JOBS).map((id) => man.textures[id] && man.textures[id].enc && man.textures[id].enc.chrome).filter(Boolean))];
if (pinned.length && (pinned.length > 1 || pinned[0] !== ver) && !rebase) {
  await browser.close();
  throw new Error('JPEG 编码器版本不同：清单钉的是 Chrome ' + pinned.join(' / ') + '，现在是 ' + ver + '（确实要换就加 --rebase，重新提交所有 JPEG）');
}
const page = await browser.newPage();
const only = args.filter((a) => !a.startsWith('--'));
let total = 0;
for (const id of Object.keys(PAINT_JOBS)) {
  if (only.length && !only.includes(id)) continue;
  const t0 = Date.now(), J = PAINT_JOBS[id];
  const ent = { gen: 'tools/gen-paint-textures.mjs', fn: J.fn, px: 512, enc: { chrome: ver, q: Q }, maps: {}, lo: { px: 256, maps: {} } };
  for (const [sec, k, f, im] of images(id)) {
    const px = rgba8(im);
    const url = await page.evaluate(
      ([b64, n, q]) => {
        const bin = atob(b64), u = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const c = document.createElement('canvas');
        c.width = c.height = n;
        c.getContext('2d').putImageData(new ImageData(u, n, n), 0, 0);
        return c.toDataURL('image/jpeg', q);
      },
      [Buffer.from(px).toString('base64'), im.N, Q]
    );
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'), file = path.join(outRoot, id, f);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    (sec === 'lo' ? ent.lo.maps : ent.maps)[k] = { pix: sha(px), jpg: sha(buf), bytes: buf.length };
    total += buf.length;
  }
  man.textures[id] = ent;
  console.log(id.padEnd(8), ((Date.now() - t0) / 1000).toFixed(1) + ' s', [...Object.values(ent.maps), ...Object.values(ent.lo.maps)].map((x) => (x.bytes / 1024).toFixed(0)).join(' / ') + ' KB');
}
await browser.close();
delete man.paint;
const sorted = {};
for (const k of Object.keys(man.textures).sort()) sorted[k] = man.textures[k];
const out = { _comment: man._comment || '程序化贴图清单：gen = 生成脚本，fn = 生成函数（种子写在代码里），px = 边长，maps 每个通道：pix = 原始像素 RGBA8 的 sha256，jpg / bytes = 仓库里 JPEG 的 sha256 和字节数；lo = 低档用的小图（同样格式），enc = 编码 JPEG 用的 Chrome 版本（gen-paint-textures.mjs 钉住）', textures: sorted };
fs.writeFileSync(manPath, JSON.stringify(out, null, 1) + '\n');
console.log('合计', (total / 1024).toFixed(0) + ' KB');
