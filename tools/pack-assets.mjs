// 把 assets/ 下的贴图和模型打包成 js/assets/*.js，让游戏从 file:// 双击打开时也能用（Chrome 不许 file:// 页面读本地文件）。
// 用法：node tools/pack-assets.mjs
// 每个包一个文件，内容是 base64：贴图（JPEG）给 THREE.TextureLoader 当 data URI 用，模型统一转成 GLB 交给 GLTFLoader.parse。
// 分包见 tools/asset-sources.json 的 packs；另外生成 js/assets/index.js（包名 → 文件、大小，贴图 id → 包名），由 index.html 直接引入。
// 没有第三方依赖，只用 Node 自带模块。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, bakeGeo } from './glb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/asset-sources.json'), 'utf8'));
const outDir = path.join(root, 'js/assets');
fs.mkdirSync(outDir, { recursive: true });

// 模型目录 → 前缀
const MODEL_DIRS = { 'kaykit-dungeon-remastered': 'kd', 'kaykit-halloween-bits': 'kh', 'kenney-nature-kit': 'kn' };

const pad4 = (n) => (n + 3) & ~3;
// .gltf + .bin + 外部贴图 → 单个 GLB（所有缓冲合成一个 BIN 块，贴图改成 bufferView 引用）
function gltfToGlb(file) {
  const dir = path.dirname(file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const chunks = [];
  let off = 0;
  const push = (buf) => {
    const at = off;
    chunks.push(buf);
    const p = pad4(buf.length) - buf.length;
    if (p) chunks.push(Buffer.alloc(p));
    off += buf.length + p;
    return at;
  };
  const bufBase = (j.buffers || []).map((b) => push(fs.readFileSync(path.join(dir, decodeURIComponent(b.uri)))));
  for (const bv of j.bufferViews || []) {
    bv.byteOffset = (bv.byteOffset || 0) + bufBase[bv.buffer];
    bv.buffer = 0;
  }
  for (const im of j.images || []) {
    if (!im.uri) continue;
    const data = fs.readFileSync(path.join(dir, decodeURIComponent(im.uri)));
    const at = push(data);
    j.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: data.length });
    im.bufferView = j.bufferViews.length - 1;
    im.mimeType = im.uri.endsWith('.png') ? 'image/png' : 'image/jpeg';
    delete im.uri;
  }
  const bin = Buffer.concat(chunks);
  j.buffers = [{ byteLength: bin.length }];
  let json = Buffer.from(JSON.stringify(j), 'utf8');
  const jp = pad4(json.length) - json.length;
  if (jp) json = Buffer.concat([json, Buffer.alloc(jp, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([head, ch(json.length, 0x4e4f534a), json, ch(bin.length, 0x004e4942), bin]);
}

function allModels() {
  const out = {};
  for (const [d, pre] of Object.entries(MODEL_DIRS)) {
    const dir = path.join(root, 'assets', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (f.endsWith('.glb')) out[pre + '/' + f.slice(0, -4)] = fs.readFileSync(p);
      else if (f.endsWith('.gltf')) out[pre + '/' + f.slice(0, -5)] = gltfToGlb(p);
    }
  }
  return out;
}

let caMan = null;
const caManifest = () => caMan || (caMan = JSON.parse(fs.readFileSync(path.join(root, 'assets/ca/manifest.json'), 'utf8')));

const index = { packs: {}, textures: {} };
let total = 0;
for (const [name, pk] of Object.entries(manifest.packs)) {
  const data = { tex: {}, models: {} };
  for (const id of pk.textures || []) {
    const t = manifest.textures[id];
    const dir = path.join(root, 'assets', t.src, id);
    data.tex[id] = {};
    for (const k of ['albedo', 'normal', 'arh']) data.tex[id][k] = fs.readFileSync(path.join(dir, k + '.jpg')).toString('base64');
    index.textures[id] = name;
  }
  if (pk.models === '*') for (const [k, buf] of Object.entries(allModels())) data.models[k] = buf.toString('base64');
  // 自产布景件（npm run build:art 生成，见 docs/art-pipeline.md）：assets/ca/manifest.json 里这个区、ship 为 true 的件，key 就是件的 id（ca/...）。
  // 打包时就烘焙成游戏要的几何体（tools/glb.mjs 的 bakeGeo，和游戏里 bakeGltf 逐位一致），游戏端不再解析 GLB / 解码调色板 / 逐顶点烘焙，
  // 进第 0 区前少一大段主线程工作。数组是小端 Float32 的 base64；sha 是烘焙所用 GLB 的 sha256（check-art 拿它和清单对）
  if (pk.kit)
    for (const a of caManifest().assets)
      if (a.zone === pk.kit && a.ship) {
        const buf = fs.readFileSync(path.join(root, a.file)), b = bakeGeo(readGlb(buf)), b64 = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
        (data.geo || (data.geo = {}))[a.id] = { sha: a.sha256, n: b.count, p: b64(b.pos), nn: b64(b.nor), c: b64(b.col), ...(b.glow ? { g: b64(b.glow) } : {}) };
      }
  // 角色模型（GLB，由 tools/convert-chars.mjs 生成）：游戏端同步解析，不经过 assets.js 的布景烘焙
  for (const [k, rel] of Object.entries(pk.chars || {})) data.models[k] = fs.readFileSync(path.join(root, 'assets', rel)).toString('base64');
  // 特效贴图（PNG，由 tools/gen-vfx-textures.mjs 生成）：游戏端 js/vfx.js 当 data URI 用
  if (pk.images) {
    data.img = {};
    for (const [k, rel] of Object.entries(pk.images)) data.img[k] = fs.readFileSync(path.join(root, 'assets', rel)).toString('base64');
  }
  const body =
    '// 自动生成（node tools/pack-assets.mjs），不要手改。素材来源与许可证见 assets/README.md\n' +
    "(window.CA_ASSETS = window.CA_ASSETS || {})['" + name + "'] = " + JSON.stringify(data) + ';\n';
  fs.writeFileSync(path.join(outDir, name + '.js'), body);
  index.packs[name] = { file: 'js/assets/' + name + '.js', bytes: body.length };
  if (pk.with) index.packs[name].with = pk.with; // 依赖包：游戏要这个包时连带加载（zone-ash 带上 kit-ash，摆放表的 packs 不用改）
  total += body.length;
  console.log(name.padEnd(12), (body.length / 1024).toFixed(0) + ' KB', Object.keys(data.tex).join(' '), Object.keys(data.models).length ? Object.keys(data.models).length + ' 个模型' : '', data.geo ? Object.keys(data.geo).length + ' 个预烘焙几何体' : '', data.img ? Object.keys(data.img).join(' ') : '');
}
fs.writeFileSync(
  path.join(outDir, 'index.js'),
  '// 自动生成（node tools/pack-assets.mjs），不要手改：素材包清单，各包在进入用到它的区域时才加载\n' +
    'window.CA_ASSET_INDEX = ' + JSON.stringify(index) + ';\n'
);
console.log('合计', (total / 1048576).toFixed(2) + ' MB');
