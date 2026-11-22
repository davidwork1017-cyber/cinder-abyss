// three 升级后的静态检查（纯 Node，一两秒）：npm test / npm run test:func 先跑它。
//  1. 游戏脚本里用到的每个 THREE.X / T.X 在 vendor/three.bundle.js 里都有（新示例模块忘了打包、three 删掉的类都会在这里报出来）
//  2. 打包文件里的本地设置还在：颜色管理关、透明双面单遍、实例矩阵初始为 0、generateUUID 和 N8AOPostPass 不取 Math.random（docs/vendor-patches.md）
//  3. r128 时代的写法（r152 起的颜色空间、r155 起的灯光、vColor 变成 vec4 等）在 js/ 里不再出现
// 用法：node tools/check-three.mjs（有问题时列出 文件:行 和原因，退出码 1）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 返回 { problems, rev, used }；test/smoke.mjs 的第一组步骤调它（只用 Node，不起浏览器），命令行跑见文件末尾
export function checkThree() {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'assets') walk(p); } // js/assets/ 是 base64 素材包
      else if (f.name.endsWith('.js')) files.push(p);
    }
  })(path.join(root, 'js'));

  // 在一个假的 window 里执行打包文件，拿到导出的名字
  const sandbox = { window: {}, console, self: {}, navigator: { userAgent: 'node' }, document: undefined, atob }; // atob：n8ao 加载时解码自带的蓝噪声
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/three.bundle.js'), 'utf8'), sandbox);
  const THREE = sandbox.window.THREE;
  const problems = [];
  if (!THREE) problems.push('vendor/three.bundle.js 没有设置 window.THREE');
  else if (THREE.ColorManagement.enabled !== false) problems.push('vendor/three.bundle.js：ColorManagement 应该是关的（见 tools/three-entry.mjs）');
  else if (new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }).forceSinglePass !== true) problems.push('vendor/three.bundle.js：透明双面材质应该单遍画（见 tools/three-entry.mjs）');
  else if (new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2).instanceMatrix.array.some((v) => v !== 0)) problems.push('vendor/three.bundle.js：新建的实例化网格实例矩阵应该全是 0（r128 的行为，见 tools/three-entry.mjs）');
  // 本地改动（docs/vendor-patches.md）：建对象、取 uuid 都不调 Math.random
  if (THREE) {
    vm.runInContext('globalThis.__rc = 0; globalThis.__rnd = Math.random; Math.random = () => (globalThis.__rc++, 0.5);', sandbox);
    try {
      for (let i = 0; i < 4; i++) THREE.MathUtils.generateUUID();
      new THREE.Texture(); new THREE.BufferGeometry(); new THREE.MeshStandardMaterial(); new THREE.Mesh(); new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2);
    // n8ao：建 N8AOPostPass、改配置重建着色器都不取 Math.random（蓝噪声是自带的贴图）
    const n8 = new THREE.N8AOPostPass(new THREE.Scene(), new THREE.PerspectiveCamera(), 64, 64);
    Object.assign(n8.configuration, { halfRes: true, aoSamples: 8, denoiseSamples: 4 });
    n8.setSize(80, 60);
    } finally { vm.runInContext('Math.random = globalThis.__rnd;', sandbox); }
    if (sandbox.__rc) problems.push('vendor/three.bundle.js：建 three 对象 / 取 uuid / 建 N8AOPostPass 调到了 Math.random（' + sandbox.__rc + ' 次）：generateUUID 的本地改动丢了（tools/build-three.mjs 的 patchThree），或者 n8ao 升级后开始取随机数，见 docs/vendor-patches.md');
  }

  // r128 → r186 的写法检查：[正则, 说明]
  const OLD = [
    [/\bsRGBEncoding\b|\bLinearEncoding\b|\boutputEncoding\b|\.encoding\s*=|encoding:\s*T\./, 'r152 起用 colorSpace（T.SRGBColorSpace / renderer.outputColorSpace），r162 删了 encoding'],
    [/WebGLMultisampleRenderTarget/, 'r138 删了：new T.WebGLRenderTarget(w, h, { samples })'],
    [/PCFSoftShadowMap/, 'r186 没有了，会退回 PCFShadowMap 并警告'],
    [/physicallyCorrectLights|useLegacyLights/, 'r165 删了旧版灯光；换算在 world.js 的 patchToonChunks 里（× PI、旧的距离衰减）'],
    [/GeometricContext|geometry\.(normal|viewDir|position|clearcoatNormal)\b/, 'r155 起光照片段里是 geometryNormal / geometryViewDir / geometryPosition'],
    [/BRDF_Specular_GGX|BRDF_Diffuse_Lambert|clearcoatDHR/, 'r155 起改名：BRDF_GGX / BRDF_Lambert，没有 clearcoatDHR'],
    [/\bvColor\b(?!\s*\.)/, 'r1xx 起着色器里的 vColor 一直是 vec4：当 vec3 用要写 vColor.rgb'],
    [/\bcapabilities\.isWebGL2\b/, 'r163 起只有 WebGL2（这个字段还在但永远是 true）'],
    [/getContext\(\s*['"]webgl['"]/, '（提示）WebGL1 上下文只用来探测设备可以，渲染器只支持 WebGL2'],
  ];
  // 有些匹配只在着色器字符串里才算问题（vColor / geometry.normal）：粗略判断这一行里有引号
  const SHADER_ONLY = new Set([4, 6]);
  const allow = /check-three:\s*ok/; // 行尾写 // check-three: ok 可以放过（真的确认过）
  const used = new Map();
  for (const f of files) {
    const rel = path.relative(root, f), src = fs.readFileSync(f, 'utf8'), lines = src.split('\n');
    // T 只在把它设成 THREE 的文件里算（别的文件里 T 是别的东西：天赋树、商人……）
    const nameRe = /const T = (window\.)?THREE\b/.test(src) ? /\b(?:T|THREE)\.([A-Z][A-Za-z0-9_]*)/g : /\bTHREE\.([A-Z][A-Za-z0-9_]*)/g;
    lines.forEach((ln, i) => {
      for (const m of ln.matchAll(nameRe)) if (!used.has(m[1])) used.set(m[1], rel + ':' + (i + 1));
      // 注入用的 #include <片段名> 在这个版本的 ShaderChunk 里还有（r154 改名过 encodings_fragment → colorspace_fragment、output_fragment → opaque_fragment 等；
      // replace 找不到目标时什么都不做，着色器照样能编译，只是注入悄悄没了）
      if (THREE) for (const m of ln.matchAll(/#include <([a-z0-9_]+)>/g)) if (!(m[1] in THREE.ShaderChunk)) problems.push(rel + ':' + (i + 1) + '  ShaderChunk 里没有 ' + m[1] + '（three 改名或删掉了，注入不会生效）');
      if (allow.test(ln)) return;
      // 画面要进后期链 / 预热的渲染目标得是 displayRT（见 world.js）：新加的目标提醒一下
      if (/new T\.(WebGLRenderTarget|EffectComposer)\(/.test(ln) && !/displayRT\(|EffectComposer\(renderer, post\.rt\)/.test(ln)) problems.push(rel + ':' + (i + 1) + '  新的渲染目标：场景要画进去再显示 / 预热着色器的话用 displayRT(...) 包一下（r153 起渲染到目标不做色调映射和 sRGB 编码）；确认不需要就在行尾写 // check-three: ok\n      ' + ln.trim().slice(0, 140));
      OLD.forEach(([re, why], k) => {
        if (k === 8) return; // 只是提示，不算错
        if (!re.test(ln)) return;
        if (SHADER_ONLY.has(k) && !/['"`]/.test(ln)) return;
        problems.push(rel + ':' + (i + 1) + '  ' + why + '\n      ' + ln.trim().slice(0, 140));
      });
    });
  }
  if (THREE) for (const [name, at] of used) if (!(name in THREE)) problems.push(at + '  THREE.' + name + ' 在 vendor/three.bundle.js 里没有（示例模块要在 tools/three-entry.mjs 里加上再 npm run build:three；或者 three 已经删了它）');
  return { problems, rev: THREE ? THREE.REVISION : null, used: used.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, rev, used } = checkThree();
  if (problems.length) {
    console.log('check-three：' + problems.length + ' 处问题\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('check-three ok：three r' + rev + '，游戏用到 ' + used + ' 个 THREE 名字，都在打包文件里');
}
