// 生成地面图层用的程序化贴图（我们自己画的，不是第三方素材，算作原创）。像素在 tools/ground-tex.mjs 里按固定种子算（只用 Node），
// 这里只负责编码：JPEG 借 playwright-core 带的 Chrome 的 canvas（和 prep-textures.mjs 一样），输出 tools/asset-sources.json 里 kinds 列的通道。
// 同时写 assets/generated/manifest.json：每张图的生成函数、尺寸、原始像素（RGBA8）的 sha256、JPEG 的 sha256 和字节数；
// check-art 只用 Node 重新算像素核对前者、读仓库里的 JPEG 核对后者（JPEG 的字节取决于 Chrome 的编码器版本，所以重新编码只在这里做）。
// 用法：node tools/gen-ground-textures.mjs [只生成的 id ...]，输出到 assets/generated/<id>/，然后 node tools/pack-assets.mjs 重新打包。
//   --manifest-only：不编码，只按仓库里现有的 JPEG 重写清单（像素照样重新算）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, rgba8, sha256 } from './ground-tex.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'assets/generated');
const args = process.argv.slice(2);
const manifestOnly = args.includes('--manifest-only');
const only = args.filter((a) => !a.startsWith('--'));
const Q = 0.84;
const sources = JSON.parse(fs.readFileSync(path.join(root, 'tools/asset-sources.json'), 'utf8'));
const manFile = path.join(outRoot, 'manifest.json');
const man = fs.existsSync(manFile) ? JSON.parse(fs.readFileSync(manFile, 'utf8')) : {};
man._comment = '程序化贴图清单（tools/gen-ground-textures.mjs 写，tools/check-art.mjs 核对）：fn = tools/ground-tex.mjs 里的生成函数（种子写在代码里），px = 边长，maps 每个通道：pix = 原始像素 RGBA8 的 sha256，jpg / bytes = 仓库里 JPEG 的 sha256 和字节数';
man.textures = man.textures || {};

let page = null, browser = null;
if (!manifestOnly) {
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
}
let total = 0;
for (const [id, job] of Object.entries(JOBS)) {
  if (only.length && !only.includes(id)) continue;
  if (job.own) continue; // tex-t1：p_* 由 tools/gen-paint-textures.mjs 编码（带 lo、钉住 Chrome 版本）
  const t0 = Date.now();
  const set3 = job.make();
  const kinds = (sources.textures[id] && sources.textures[id].kinds) || ['albedo', 'normal', 'arh'];
  const dir = path.join(outRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const ent = { gen: 'tools/gen-ground-textures.mjs', fn: job.fn, px: set3.albedo.N, maps: {} };
  for (const k of kinds) {
    const im = set3[k], px = rgba8(im), file = path.join(dir, k + '.jpg');
    if (!manifestOnly) {
      const url = await page.evaluate(
        ([b64, N, q]) => {
          const bin = atob(b64), u = new Uint8ClampedArray(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          const c = document.createElement('canvas');
          c.width = c.height = N;
          c.getContext('2d').putImageData(new ImageData(u, N, N), 0, 0);
          return c.toDataURL('image/jpeg', q);
        },
        [Buffer.from(px).toString('base64'), im.N, Q]
      );
      fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    }
    const buf = fs.readFileSync(file);
    total += buf.length;
    ent.maps[k] = { pix: sha256(px), jpg: sha256(buf), bytes: buf.length };
  }
  man.textures[id] = ent;
  console.log(id.padEnd(16), ((Date.now() - t0) / 1000).toFixed(1) + ' s');
}
if (browser) await browser.close();
const sorted = {};
for (const k of Object.keys(man.textures).sort()) sorted[k] = man.textures[k];
fs.writeFileSync(manFile, JSON.stringify({ _comment: man._comment, textures: sorted }, null, 1) + '\n');
console.log('合计', (total / 1024).toFixed(0) + ' KB');
