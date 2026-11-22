# 第三方库的本地改动

`vendor/` 里的库原则上原样不改。改了的都记在这里。升级或替换这个库时，要把改动照样补上，再跑一遍下面写的检查。

## three.js r186：`vendor/three.bundle.js` 的 uuid 生成

- **在哪改**：不手改打包文件。`tools/build-three.mjs` 打包时（esbuild 的 onLoad 插件 `patchThree`）改 `node_modules/three/build/three.core.js` 里的 `generateUUID`：原来每个 uuid 取 4 次 `Math.random()`，改成用自带的 xorshift128（`_cinderRnd`，固定种子，生成器和种子都和 r128 时 `vendor/three.min.js` 里的 `ctR` 一样）。改动处带 `cinder-abyss 本地改动` 注释（压缩后注释没了，看 `build-three.mjs`）。要替换的原文（4 行 `Math.random() * 0xffffffff | 0`）和 `function generateUUID() {` 都必须恰好出现一次，否则打包直接失败；替换后 `generateUUID` 里还能找到 `Math.random(` 也失败。
- **为什么**：建区外观时，`Math.random` 被换成按布局取种子的布景随机序列（`js/world.js` 的 `withVisualRandom`）。three 每建一个贴图、材质、几何体或网格，都会从这个序列里取走 4 个数。可是建多少个对象并不固定：几何体和材质有缓存，第一次建区和素材后到时的原地重建取走的个数不同；布景件换成自产件或退回程序化外观，个数也不同；r138 起每张贴图还多一个 `TextureSource`（也有 uuid）。只要取走的个数一变，后面所有的布景（岩石、熔岩裂缝、炉址石板圈、贴花）都会整体挪位。uuid 只用来标识对象，不影响渲染顺序，换个来源不会改变画面。
- **r186 不再需要的旧办法**：第一次升级尝试（vf-three 分支）是把 `TextureSource.uuid` 改成第一次读才生成，让 r186 取随机数的次数和 r128 一样。现在 uuid 根本不碰 `Math.random`，`TextureSource` 多一个 uuid 也不会挪动布景序列，所以那处改动没有带过来，打包时只改 `generateUUID` 这一处。
- **怎么查**：
  - `node tools/check-three.mjs`（`npm test` 和 `npm run test:func` 先跑）：在 Node 里加载打包文件，建几个 three 对象、取几个 uuid，`Math.random` 被调到就失败。
  - `test/smoke.mjs` 里「确定性」那一步：页面里同样查一遍 0 次调用；再把同一个区按高、低、高原地重建三次，用 `G.world.dressHash()` 比较三次的布景指纹，必须逐位相同。（步骤名里还写着 r128 时的文件名 `vendor/three.min.js`：步骤名是这一步随机数的种子，没改。）
- **升级 three 时**：`npm install --save-dev --save-exact three@<新版本>`，`npm run build:three`。原文变了打包会失败，按新原文改 `patchThree`，保留这一节。

## three.js r186：打包入口里的两处设置（`tools/three-entry.mjs`）

不是改 three 的源码，是加载后、游戏脚本之前改的默认值，`check-three` 会查：

- `ColorManagement.enabled = false`：游戏沿用 r128 的颜色写法（十六进制色按原值存、需要线性时自己 `convertSRGBToLinear()`）。
- `Material.prototype.forceSinglePass` 恒为 true：r150 起透明的双面材质要画两遍（先背面再正面），游戏里这类材质都是平面特效 / 贴花，两遍只多 draw。

## three.js r186：后期目标标成 `isXRRenderTarget`（`js/world.js` 的 `displayRT`）

也不是改源码，但用到了 three 的内部约定，记在这里：r153 起渲染到目标一律线性、不做色调映射；后期链（泛光、调色、暗角、SMAA / FXAA）要的是 r128 那种「目标里已经是显示空间」的画面，所以后期目标、预热目标都标成 `isXRRenderTarget`，three 对这种目标照屏幕处理（色调映射 + sRGB 编码）。three 源码注释说这个标记以后可能去掉（#23278）。去掉的话：给 `toneMapped: false` 的材质加一个 define，在 `tonemapping_fragment` / `colorspace_fragment` 里按 define 自己做（机械改）。`test/smoke.mjs`「画面：three r186」一步会查后期目标是不是 displayRT、高 / 低画质亮度是否相近。

## 历史：three.js r128 的 `vendor/three.min.js`

r128 的 `three.min.js` 有同样的 uuid 改动（压缩代码里的 `ct` / `ctR`）。升级到 r186 后它挪到了 `tools/vendor/r128/`，只给离线工具 `tools/convert-chars.mjs` 用（FBXLoader 还是 r128 版），游戏不加载。
