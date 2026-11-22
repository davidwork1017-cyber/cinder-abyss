// 打包 three.js：node tools/build-three.mjs（或 npm run build:three）
// 入口 tools/three-entry.mjs → vendor/three.bundle.js（IIFE、压缩、无 source map），产物提交进仓库，GitHub Pages 直接发。
// 对 three 源码有一处打包时的修改（patchThree，见下，记在 docs/vendor-patches.md）。
// three 和 esbuild 的版本钉在 package.json（devDependencies，精确版本）；先 npm install。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/three/package.json'), 'utf8'));
const out = path.join(root, 'vendor/three.bundle.js');

// 打包时对 three 源码做的唯一一处修改：generateUUID 不取 Math.random，改用自带的 xorshift128（固定种子，和 r128 版 vendor/three.min.js 的 ctR 同一个生成器、同一个种子）。
// 原因：区域外观在 withVisualRandom（world.js）里建，那段时间 Math.random 换成了按布局取种子的布景随机序列；three 每建一个对象（贴图、TextureSource、材质、
// 几何体、网格）取 4 个随机数当 uuid。建多少个对象并不固定（缓存命中、素材后到时的原地重建、r138 起每张贴图多一个 TextureSource），
// 只要个数一变，后面的布景就整体挪位。uuid 只是标识，不参与渲染，换来源不影响画面。
// 找不到要改的原文就让打包失败（升级 three 后按新原文改这里），test/smoke.mjs「确定性」一步在页面里再查一遍。
const UUID_ORIG = [
  '\tconst d0 = Math.random() * 0xffffffff | 0;',
  '\tconst d1 = Math.random() * 0xffffffff | 0;',
  '\tconst d2 = Math.random() * 0xffffffff | 0;',
  '\tconst d3 = Math.random() * 0xffffffff | 0;',
].join('\n');
const UUID_NEW = [
  '\t// cinder-abyss 本地改动（docs/vendor-patches.md，由 tools/build-three.mjs 打包时改上）：uuid 用自带的 xorshift128，不取 Math.random。',
  '\t// 建区外观时 Math.random 是按布局取种子的布景随机序列，每建一个对象取 4 次会让布景随对象 / 缓存数量挪位。test/smoke.mjs「确定性」一步会查',
  '\tconst d0 = _cinderRnd();',
  '\tconst d1 = _cinderRnd();',
  '\tconst d2 = _cinderRnd();',
  '\tconst d3 = _cinderRnd();',
].join('\n');
const UUID_RNG = [
  '// cinder-abyss 本地改动：generateUUID 用的 xorshift128（种子和 r128 版一样）',
  'const _cinderS = [ 2654435769, 608135816, 3084996962, 1481765933 ];',
  'function _cinderRnd() {',
  '\tlet t = _cinderS[ 3 ];',
  '\tconst s = _cinderS[ 0 ];',
  '\t_cinderS[ 3 ] = _cinderS[ 2 ]; _cinderS[ 2 ] = _cinderS[ 1 ]; _cinderS[ 1 ] = s;',
  '\tt ^= t << 11; t ^= t >>> 8;',
  '\t_cinderS[ 0 ] = t ^ s ^ ( s >>> 19 );',
  '\treturn _cinderS[ 0 ] | 0;',
  '}',
  '',
  'function generateUUID() {',
].join('\n');
const patchThree = {
  name: 'cinder-three-patch',
  setup(b) {
    b.onLoad({ filter: /[\\/]three[\\/]build[\\/]three\.core\.js$/ }, (args) => {
      let src = fs.readFileSync(args.path, 'utf8');
      const once = (a, what) => {
        const n = src.split(a).length - 1;
        if (n !== 1) throw new Error('three.core.js 里' + what + '出现 ' + n + ' 次（应为 1 次）：three 升级后要按新原文改 tools/build-three.mjs 的 patchThree');
      };
      once(UUID_ORIG, ' generateUUID 的 4 次 Math.random ');
      once('\nfunction generateUUID() {', ' function generateUUID() ');
      src = src.replace(UUID_ORIG, UUID_NEW).replace('\nfunction generateUUID() {', '\n' + UUID_RNG);
      const body = src.slice(src.indexOf('function generateUUID() {'), src.indexOf('function generateUUID() {') + 1200);
      if (/Math\.random\(/.test(body.slice(0, body.indexOf('return uuid')))) throw new Error('patchThree 之后 generateUUID 里还有 Math.random');
      return { contents: src, loader: 'js' };
    });
  },
};
await build({
  entryPoints: [path.join(root, 'tools/three-entry.mjs')],
  outfile: out,
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2020'],
  legalComments: 'none',
  banner: { js: '/* three.js r' + pkg.version.split('.')[1] + ' (npm three@' + pkg.version + ') + examples/jsm 后期处理 / GLTFLoader，MIT 许可证，Copyright 2010-2026 three.js authors（全文见 vendor/LICENSE-three.txt）。由 tools/build-three.mjs 打包（generateUUID 有一处本地改动，见 docs/vendor-patches.md），不要手改 */' },
  logLevel: 'warning',
  plugins: [patchThree],
});
// 许可证全文放在打包文件旁边（压缩时去掉了源码里的注释）
fs.copyFileSync(path.join(root, 'node_modules/three/LICENSE'), path.join(root, 'vendor/LICENSE-three.txt'));
const n = fs.statSync(out).size;
console.log('vendor/three.bundle.js', (n / 1024).toFixed(0) + ' KiB', 'three@' + pkg.version);
