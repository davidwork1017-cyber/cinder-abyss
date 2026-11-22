# 第三方库

`three.bundle.js`：three.js **r186**（npm `three@0.186.1`）加上同一版本 `examples/jsm/` 里的示例模块，MIT 许可证（全文 `LICENSE-three.txt`），由 `tools/build-three.mjs` 用 esbuild 打成一个经典脚本（IIFE），加载后挂在 `window.THREE` 上。不要手改，改了就重新打包。

| 打进去的模块 | 来源（npm `three@0.186.1`） |
| --- | --- |
| three 本体（全部导出） | `build/three.module.js` + `build/three.core.js` |
| `EffectComposer` | `examples/jsm/postprocessing/EffectComposer.js` |
| `RenderPass` | `examples/jsm/postprocessing/RenderPass.js` |
| `ShaderPass` | `examples/jsm/postprocessing/ShaderPass.js` |
| `UnrealBloomPass` | `examples/jsm/postprocessing/UnrealBloomPass.js` |
| `SMAAPass` | `examples/jsm/postprocessing/SMAAPass.js` |
| `CopyShader` | `examples/jsm/shaders/CopyShader.js` |
| `LuminosityHighPassShader` | `examples/jsm/shaders/LuminosityHighPassShader.js` |
| `SMAAEdgesShader` / `SMAAWeightsShader` / `SMAABlendShader` | `examples/jsm/shaders/SMAAShader.js` |
| `FXAAShader` | `examples/jsm/shaders/FXAAShader.js` |
| `GLTFLoader` | `examples/jsm/loaders/GLTFLoader.js` |

本地改动只有一处（打包时改，不手改产物）：`generateUUID` 不取 `Math.random`。为什么、怎么查，见 `docs/vendor-patches.md`。打包入口 `tools/three-entry.mjs` 还设了两个默认值：`ColorManagement.enabled = false`、透明双面材质单遍画（同见 `docs/vendor-patches.md`）。

## 什么时候要重新打包

只有升级 three、或者要用一个新的示例模块时：

```
npm install                 # three / esbuild 的版本钉在 package.json（精确版本）
# 升级：npm install --save-dev --save-exact three@<新版本>；新示例模块：在 tools/three-entry.mjs 里 import 并挂到 THREE 上
npm run build:three         # 重新生成 vendor/three.bundle.js（和 LICENSE-three.txt），一起提交
npm run check:three         # 游戏用到的 THREE.X 都在包里、本地改动还在、没有 r128 写法
```

改游戏代码（`js/*.js`）不用重新打包，游戏本身也不需要 node_modules。

转换工具 `tools/convert-chars.mjs` 仍用 r128 的原版文件，在 `tools/vendor/r128/`，游戏不加载它们。
