// 下载并预处理地面 / 岩壁的 CC0 PBR 贴图（Poly Haven / ambientCG，1k）。
// 用法：node tools/prep-textures.mjs [缓存目录，默认 .asset-cache] [只处理的贴图 id ...]
// 每套贴图输出到 assets/<来源>/<id>/ 下三张 JPEG：
//   albedo.jpg  反照率（sRGB）
//   normal.jpg  法线（OpenGL 约定，+Y 朝上）
//   arh.jpg     R = 环境光遮蔽（Lava001 改放自发光）、G = 粗糙度、B = 高度（地面混合用）
// 原图只放在缓存目录里，不进仓库；仓库里留的是压缩后的三张图（来源地址见 tools/asset-sources.json）。
// 图像处理借用 playwright-core 带的 Chrome（项目已有的开发依赖）里的 canvas，不引入别的依赖。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/asset-sources.json'), 'utf8'));
const cache = path.resolve(process.argv[2] || path.join(root, '.asset-cache'));
const only = process.argv.slice(3);
const Q = { albedo: 0.8, normal: 0.84, arh: 0.8 };

async function get(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (asset-prep)' } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

// 下载原图，返回 { albedo, normal, ao, rough, height }（本地路径；没有的通道为 null）
async function fetchSet(id, t) {
  const dir = path.join(cache, id);
  fs.mkdirSync(dir, { recursive: true });
  if (t.src === 'polyhaven') {
    const files = await (await fetch('https://api.polyhaven.com/files/' + id)).json();
    const pick = async (k) => {
      const u = files[k]['1k'].jpg.url;
      const f = path.join(dir, path.basename(u));
      await get(u, f);
      return f;
    };
    const arm = await pick('arm');
    return { albedo: await pick('Diffuse'), normal: await pick('nor_gl'), arm, height: await pick('Displacement') };
  }
  const zip = path.join(dir, id + '.zip');
  await get('https://ambientcg.com/get?file=' + id + '_1K-JPG.zip', zip);
  execFileSync('unzip', ['-o', '-q', zip, '*.jpg', '-d', dir]);
  const f = (s) => {
    const p = path.join(dir, id + '_1K-JPG_' + s + '.jpg');
    return fs.existsSync(p) ? p : null;
  };
  return { albedo: f('Color'), normal: f('NormalGL'), ao: t.rFrom ? f(t.rFrom) : f('AmbientOcclusion'), rough: f('Roughness'), height: f('Displacement') };
}

const uri = (p) => (p ? 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64') : null);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
let total = 0;
for (const [id, t] of Object.entries(manifest.textures)) {
  if (only.length && !only.includes(id)) continue;
  if (t.src === 'generated') continue; // 程序化贴图由 tools/gen-ground-textures.mjs 生成，不下载
  const s = await fetchSet(id, t);
  const out = await page.evaluate(
    async ([s, Q]) => {
      const load = (u) => new Promise((res, rej) => { if (!u) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
      const S = 1024;
      const px = (img) => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, S, S);
        return g.getImageData(0, 0, S, S).data;
      };
      const enc = (img, q) => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        c.getContext('2d').drawImage(img, 0, 0, S, S);
        return c.toDataURL('image/jpeg', q);
      };
      const [albedo, normal, arm, ao, rough, height] = await Promise.all([s.albedo, s.normal, s.arm, s.ao, s.rough, s.height].map(load));
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      const im = g.createImageData(S, S), d = im.data;
      const A = arm ? px(arm) : null, O = ao ? px(ao) : null, R = rough ? px(rough) : null, H = height ? px(height) : null;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = A ? A[i] : O ? O[i] : 255;
        d[i + 1] = A ? A[i + 1] : R ? R[i] : 200;
        d[i + 2] = H ? H[i] : 128;
        d[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      return { albedo: enc(albedo, Q.albedo), normal: enc(normal, Q.normal), arh: c.toDataURL('image/jpeg', Q.arh) };
    },
    [{ albedo: uri(s.albedo), normal: uri(s.normal), arm: uri(s.arm), ao: uri(s.ao), rough: uri(s.rough), height: uri(s.height) }, Q]
  );
  const dir = path.join(root, 'assets', t.src, id);
  fs.mkdirSync(dir, { recursive: true });
  let sz = 0;
  for (const k of ['albedo', 'normal', 'arh']) {
    const buf = Buffer.from(out[k].split(',')[1], 'base64');
    fs.writeFileSync(path.join(dir, k + '.jpg'), buf);
    sz += buf.length;
  }
  total += sz;
  console.log(id.padEnd(24), (sz / 1024).toFixed(0) + ' KB');
}
await browser.close();
console.log('合计', (total / 1048576).toFixed(2) + ' MB');
