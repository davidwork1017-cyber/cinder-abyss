// three.js 打包入口：node tools/build-three.mjs 把它打成 vendor/three.bundle.js（IIFE，一个文件）。
// 游戏脚本仍是经典脚本、读全局 window.THREE：这里把 three 的全部导出和游戏用到的示例模块（同一版本）挂到一个普通对象上。
// 只有升级 three 或增减示例模块时才需要重新打包；改游戏代码不用。
import * as THREE_NS from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { N8AOPostPass } from 'n8ao';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import { SMAAEdgesShader, SMAAWeightsShader, SMAABlendShader } from 'three/addons/shaders/SMAAShader.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 颜色管理关掉（r152 起默认开）：游戏代码沿用 r128 的写法，十六进制色按原值存进 Color、需要线性时自己 convertSRGBToLinear()。
// 开着的话 new Color(hex) / color.set(hex) 会再换算一次，所有颜色都会变暗。贴图的 colorSpace 和输出的 sRGB 编码不受这个开关影响。
// 必须在任何 Color 建出来之前关，所以放在打包入口里（游戏脚本加载之前）。
THREE_NS.ColorManagement.enabled = false;

// 透明的双面材质一律单遍画（r128 的行为）：r150 起 three 会先画背面再画正面（两次 draw），游戏里的双面透明特效 / 贴花都是平面，
// 两遍只多 draw 不多效果（低画质的 draw 不许涨）。原型上放一个只读的访问器：构造函数里的 this.forceSinglePass = false 不生效
Object.defineProperty(THREE_NS.Material.prototype, 'forceSinglePass', { get() { return true; }, set() {}, configurable: true });

// Color 转成十六进制 / CSS 字符串按 r128 的算法：每个分量 × 255 后截掉小数（r186 改成四舍五入并截到 0–255）。
// 游戏里 mixHex / hexOf 和画布贴图的颜色都经过这几个函数，改成四舍五入后很多颜色整体亮了 1 级（每张图 ΔE 0.3 左右的底噪）。
// 颜色管理关着，r186 版的 colorSpace 参数本来也不做换算，这里直接忽略
THREE_NS.Color.prototype.getHex = function () {
  return ((this.r * 255) << 16) ^ ((this.g * 255) << 8) ^ ((this.b * 255) << 0);
};
THREE_NS.Color.prototype.getHexString = function () {
  return ('000000' + this.getHex().toString(16)).slice(-6);
};
THREE_NS.Color.prototype.getStyle = function () {
  return 'rgb(' + ((this.r * 255) | 0) + ',' + ((this.g * 255) | 0) + ',' + ((this.b * 255) | 0) + ')';
};

// 实例化网格新建时实例矩阵全是 0（r128 的行为；r150 起 three 填成单位矩阵）：游戏里有的实例化网格（火盆的火苗方片）建好后要到下一次 W.update 才写矩阵，
// 单位矩阵的话那之前每个实例都是原点上一块 1 m 的方片；全 0 的矩阵画出来是退化三角形，什么都看不见。也让摆放探针和 r128 逐位对得上
class InstancedMesh extends THREE_NS.InstancedMesh {
  constructor(geometry, material, count) {
    super(geometry, material, count);
    this.instanceMatrix.array.fill(0);
  }
}

// 命名空间对象是只读的，拷成普通对象，游戏 / 测试才能往上挂东西（和 r128 的 three.min.js 一样）
const THREE = Object.assign({}, THREE_NS, {
  InstancedMesh,
  EffectComposer, RenderPass, ShaderPass, UnrealBloomPass, SMAAPass, Pass, N8AOPostPass,
  CopyShader, LuminosityHighPassShader, SMAAEdgesShader, SMAAWeightsShader, SMAABlendShader, FXAAShader, GLTFLoader,
});
window.THREE = THREE;
