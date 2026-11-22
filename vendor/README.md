# 第三方库

全部是 three.js **r128**（npm `three@0.128.0`），MIT 许可证。示例模块取自非 module 版的 `examples/js/`，与 `three.min.js` 同一版本，原样未改（`three.min.js` 有一处本地改动，见表下）：

| 文件 | 来源 |
| --- | --- |
| `three.min.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js |
| `EffectComposer.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/EffectComposer.js |
| `RenderPass.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/RenderPass.js |
| `ShaderPass.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/ShaderPass.js |
| `UnrealBloomPass.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/UnrealBloomPass.js |
| `CopyShader.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/CopyShader.js |
| `LuminosityHighPassShader.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/LuminosityHighPassShader.js |
| `GLTFLoader.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js |
| `SMAAPass.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/SMAAPass.js |
| `SMAAShader.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/SMAAShader.js |
| `FXAAShader.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/FXAAShader.js |

**`three.min.js` 的本地改动（只有一处）：** uuid 生成函数（压缩后叫 `ct`，即 `THREE.MathUtils.generateUUID`）原来每个 uuid 取 4 次 `Math.random()`，改成用它自己的 xorshift128（固定种子，`ctR`）。
原因：建区外观时 `Math.random` 是按布局取种子的外观随机序列（`world.js` 的 `withVisualRandom`），新建一个贴图 / 材质 / 几何体 / 网格就会取掉 4 个数；几何体和材质有缓存，同一个区第一次建和素材后到时原地重建取掉的个数不一样，后面所有布景（岩石、熔岩裂缝、炉址石板圈、贴花）就挪了位置，同一棵树每次打开都可能不一样。uuid 只是标识，不参与渲染顺序，换来源不影响画面。
升级 three（vf-three 分支）时要把这一处照样改上：`generateUUID` 不能再碰 `Math.random`。

