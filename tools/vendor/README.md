# 转换工具用的第三方文件（只给 tools/convert-chars.mjs 用，游戏不加载）

three.js **r128**（npm `three@0.128.0`），MIT 许可证，原样未改：

| 文件 | 来源 |
| --- | --- |
| `FBXLoader.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/FBXLoader.js |
| `fflate.min.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/fflate.min.js（fflate 0.6.9，MIT） |
| `NURBSUtils.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/curves/NURBSUtils.js |
| `NURBSCurve.js` | https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/curves/NURBSCurve.js |

`r128/three.min.js`、`r128/GLTFLoader.js`：游戏升级到 r186 之前用的 three r128 和它的 GLTFLoader（`three.min.js` 带 uuid 的本地改动，见 docs/vendor-patches.md 最后一节），转换工具要和 FBXLoader 同一版本，留在这里。
