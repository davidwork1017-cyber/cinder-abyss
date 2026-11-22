// three.js 打包入口：node tools/build-three.mjs 把它打成 vendor/three.bundle.js（IIFE，一个文件）。
// 游戏脚本仍是经典脚本、读全局 window.THREE：这里把 three 的全部导出和游戏用到的示例模块（同一版本）挂到一个普通对象上。
// 只有升级 three 或增减示例模块时才需要重新打包；改游戏代码不用。
import * as THREE_NS from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
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

// 命名空间对象是只读的，拷成普通对象，游戏 / 测试才能往上挂东西（和 r128 的 three.min.js 一样）
const THREE = Object.assign({}, THREE_NS, {
  EffectComposer, RenderPass, ShaderPass, UnrealBloomPass, SMAAPass,
  CopyShader, LuminosityHighPassShader, SMAAEdgesShader, SMAAWeightsShader, SMAABlendShader, FXAAShader, GLTFLoader,
});
window.THREE = THREE;
