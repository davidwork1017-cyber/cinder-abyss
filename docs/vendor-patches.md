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

## three.js r186：打包入口里的设置（`tools/three-entry.mjs`）

three 加载后、游戏脚本之前，入口里改了几处默认行为（源码不动），都是为了和 r128 的画面、行为一致，`check-three` 会查：

- `ColorManagement.enabled = false`：游戏沿用 r128 的颜色写法（十六进制色按原值存、需要线性时自己 `convertSRGBToLinear()`）。
- `Material.prototype.forceSinglePass` 恒为 true：r150 起透明的双面材质要画两遍（先背面再正面），游戏里这类材质都是平面特效 / 贴花，两遍只多 draw。
- `Color.getHex / getHexString / getStyle` 按 r128 截断小数（r186 四舍五入并截到 0–255）：`mixHex`、`hexOf` 和画布贴图的颜色都经过它们，四舍五入会让很多颜色亮 1 级。
- `THREE.InstancedMesh` 换成一个子类，新建时实例矩阵全是 0（r128 的行为；r150 起是单位矩阵）：建好后到下一次 `W.update` 才写矩阵的网格（火盆火苗），中间那一帧不会在原点画出一排方片；摆放探针也能和 r128 逐位对上。

## three.js r186：后期目标标成 `isXRRenderTarget`（`js/world.js` 的 `displayRT`）

源码同样没动，但这里用到了 three 的内部约定，所以记下来：r153 起渲染到目标一律线性、不做色调映射；后期链（泛光、调色、暗角、SMAA / FXAA）要的是 r128 那种「目标里已经是显示空间」的画面，所以后期目标、预热目标都标成 `isXRRenderTarget`，three 对这种目标照屏幕处理（色调映射 + sRGB 编码）。three 源码注释说这个标记以后可能去掉（#23278）。去掉的话：给 `toneMapped: false` 的材质加一个 define，在 `tonemapping_fragment` / `colorspace_fragment` 里按 define 自己做（机械改）。`test/smoke.mjs`「画面：three r186」一步会查后期目标是不是 displayRT、高 / 低画质亮度是否相近。

## three.js r186：`js/world.js` 里按 r128 补回的渲染行为

升级时逐张截图对比（每个区高 / 低、HUD、特写、混战）找出来的差异，都在游戏代码里补回，three 的源码不动。three 再升级时要逐条核对：

| 差异（r186 的做法） | 补回 | 位置 |
| --- | --- | --- |
| 灯光按物理单位，直射 / 半球光少乘 π，点光源平方反比衰减；漫反射乘 (1 - F) | 卡通光照片段里乘回 π、换回旧的衰减公式、去掉 (1 - F)；环境 BRDF 用解析近似 | `patchToonChunks`（每处替换要求原文恰好出现一次，否则 `console.error`） |
| 渲染到目标不做色调映射和 sRGB 编码 | 后期 / 预热 / FXAA 目标标成 `isXRRenderTarget`（见下一节） | `displayRT` |
| 删了 PCF 的「软」档，PCF 是 5 次抖动的圆盘取样 | 把 PCF 的取样换回 r128 PCFSoft 的 3×3 双线性 | `patchToonChunks`（`shadowmap_pars_fragment`） |
| 透明物体同一 renderOrder 里按包围球中心的深度排序 | `renderer.setTransparentSort` 按物体原点的深度排（地面贴花和积灰斑块 / 地面光晕的先后） | `W.init` |
| sRGB 贴图用硬件格式，先解码再过滤、在线性空间生成 mipmap | 深渊底、地面贴花的反照率不标 `SRGBColorSpace`，材质设 `DECODE_VIDEO_TEXTURE`，采样后再解码 | `deepMat`、`decalMeshOf` |
| UnrealBloomPass 的合成多乘了 alpha、亮度权重换成 Rec.709、模糊核换了、中间目标是半浮点 | 强度传 k²、高通用回 0.299 / 0.587 / 0.114、模糊核用回 r128 的、中间目标用回 8 位 | `initPost`、`applyZonePost` |
| 内置材质的 `vUv` 改名（`vMapUv` 等） | 注入代码里用新名字 | `vfxMolten` |

## 历史：three.js r128 的 `vendor/three.min.js`

r128 的 `three.min.js` 有同样的 uuid 改动（压缩代码里的 `ct` / `ctR`）。升级到 r186 后它挪到了 `tools/vendor/r128/`，只给离线工具 `tools/convert-chars.mjs` 用（FBXLoader 还是 r128 版），游戏不加载。
